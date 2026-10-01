/**
 * The partner's voice.
 *
 * Synthesis is a function of the text and the voice settings and nothing else —
 * no session, no turn, no learner. That is what lets it sit off the turn path
 * entirely (ADR 0007): this module is called from an HTTP route the learner
 * triggers with a tap, and it cannot reach a turn even by accident.
 *
 * Three things about this API are load-bearing and easy to get wrong:
 *
 * - **A failed call still returns HTTP 200.** The real status is in
 *   `base_resp.status_code`. Branching on the HTTP status treats every failure
 *   as a success and hands the client a body with no audio in it.
 * - **`data.audio` is hex, not base64.** `Buffer.from(audio, "hex")`.
 * - **The subtitle payload is a signed URL that expires in 24 hours.** It has to
 *   be fetched during synthesis and stored, because a cached reference to it is
 *   a reference to nothing a week later.
 */

import { createHash } from "node:crypto";
import { positiveNumber, regionHost, requireApiKey } from "./minimaxHost";
import { readEntry, writeEntry } from "./ttsCache";

/**
 * The longest line the API accepts. A partner turn is nowhere near this; the
 * limit is here so an oversized request fails as a clear local error instead of
 * an opaque `2013` from the far end.
 */
const MAX_CHARS = 10_000;

const EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "whisper",
] as const;

export type TtsEmotion = (typeof EMOTIONS)[number];

export class TtsError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number;
  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = "TtsError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export function ttsTimeoutMs(): number {
  return positiveNumber("TTS_TIMEOUT_MS", 20_000);
}

/**
 * One timed word, which is what karaoke highlighting will need and what the
 * subtitle payload already carries. Times are float milliseconds from the start
 * of the audio.
 */
export interface TimedWord {
  word: string;
  wordBegin: number;
  wordEnd: number;
  timeBegin: number;
  timeEnd: number;
}

export interface SubtitleSegment {
  text: string;
  textBegin: number;
  textEnd: number;
  timeBegin: number;
  timeEnd: number;
  words: TimedWord[];
}

/**
 * Everything that changes the audio.
 *
 * The set is deliberately exhaustive rather than convenient: each field here is
 * a different sound, so a cache key that omitted one would serve the wrong
 * voice's audio to a learner who changed the setting. `cacheKey` hashes the whole
 * object, so adding a setting to this interface is enough to invalidate
 * everything that depended on the old one — no manual version bump.
 */
export interface VoiceSettings {
  model: string;
  voiceId: string;
  speed: number;
  volume: number;
  pitch: number;
  emotion: TtsEmotion | null;
  languageBoost: string;
  format: string;
  sampleRate: number;
  bitrate: number;
  channel: number;
  /** Kana or romaji overrides, keyed on the surface form. Empty unless configured. */
  pronunciationDict: string[];
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/**
 * The voice, resolved from the environment.
 *
 * Clamping is not defensive programming, it is a documented gap in the API: an
 * out-of-range `speed` is accepted and synthesised without complaint, so the
 * only chance to reject it is here. The ranges are the documented ones.
 */
export function voiceSettings(): VoiceSettings {
  const rawEmotion = (process.env.TTS_EMOTION || "").trim();
  const emotion = (EMOTIONS as readonly string[]).includes(rawEmotion)
    ? (rawEmotion as TtsEmotion)
    : null;

  const dict = (process.env.TTS_PRONUNCIATION_DICT || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule.includes("/"));

  return {
    model: process.env.TTS_MODEL || "speech-2.8-hd",
    // An izakaya counter who is generous with the bottle is the right default
    // for the first scenario and not wrong for the other two. Override it for a
    // different register; every Japanese voice id is in the system voice list.
    voiceId: process.env.TTS_VOICE_ID || "Japanese_GenerousIzakayaOwner",
    speed: num("TTS_SPEED", 1.0, 0.5, 2),
    volume: num("TTS_VOLUME", 1.0, 0.1, 10),
    pitch: num("TTS_PITCH", 0, -12, 12),
    emotion,
    languageBoost: process.env.TTS_LANGUAGE_BOOST || "Japanese",
    format: "mp3",
    sampleRate: num("TTS_SAMPLE_RATE", 32000, 8000, 44100),
    bitrate: num("TTS_BITRATE", 128000, 32000, 256000),
    channel: 1,
    pronunciationDict: dict,
  };
}

function baseUrl(): string {
  if (process.env.MOCK_TTS_URL) return process.env.MOCK_TTS_URL;
  return `${regionHost()}/v1/t2a_v2`;
}

export interface Synthesis {
  audio: Buffer;
  subtitles: SubtitleSegment[];
  /** See `CacheEntry.subtitlesResolved`. False means the timings are missing. */
  subtitlesResolved: boolean;
  /** Billable characters, straight from the API. What the feature costs. */
  usageCharacters: number;
  audioLengthMs: number;
  /** False when this came out of the cache and cost nothing. */
  synthesized: boolean;
}

interface ApiResponse {
  data?: {
    audio?: string;
    subtitle_file?: string;
  } | null;
  extra_info?: {
    usage_characters?: number;
    audio_length?: number;
    audio_size?: number;
  };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * One place per status code, so a new code cannot be described in one switch
 * and forgotten in the other — which is how a transient failure ends up reported
 * to the learner as permanent.
 *
 * `retryable` is a judgement call and biased the safe way: being wrong in the
 * retryable direction costs a second round trip, being wrong the other way shows
 * the learner a permanent-looking failure for a blip.
 */
const STATUS: Record<number, { message: string; retryable: boolean }> = {
  0: { message: "The voice call failed.", retryable: false },
  1000: { message: "The voice call failed.", retryable: true },
  1001: { message: "Synthesis timed out.", retryable: true },
  1002: { message: "The voice service is rate limiting us.", retryable: true },
  1004: { message: "The voice service rejected the API key.", retryable: false },
  1008: { message: "The voice service reports the account is out of credit.", retryable: false },
  1024: { message: "The voice service had an internal error.", retryable: true },
  1039: { message: "The voice service is rate limiting us.", retryable: true },
  2013: { message: "The voice service rejected the request.", retryable: false },
  2049: { message: "The voice service rejected the API key.", retryable: false },
  2054: { message: "The voice id does not exist.", retryable: false },
};

function statusFor(code: number, msg: string): { message: string; retryable: boolean } {
  const known = STATUS[code];
  if (!known) return { message: `The voice call failed (${code}). ${msg}`, retryable: false };
  // The service's own message is worth showing for the codes that are
  // configuration problems, where the detail is the whole answer.
  const detail = code === 2013 || code === 2054 ? ` ${msg}` : "";
  return { message: `${known.message}${detail}`, retryable: known.retryable };
}

/**
 * Fetch and immediately materialise the subtitle payload.
 *
 * A failure here is not a synthesis failure — the audio is already paid for and
 * perfectly usable, and the subtitles are for a feature that is not built yet.
 * So this returns nothing rather than throwing, and the caller stores the audio
 * regardless.
 */
/**
 * The wire shape of one subtitle entry, which is snake_case like the rest of the
 * response. Kept separate from `SubtitleSegment` so the translation happens here
 * and nowhere else: reading `timeBegin` off this object type-checks fine and
 * yields `undefined`, which drops the whole segment on the floor with no error
 * anywhere. That is a silent loss of the exact data this cache exists to keep.
 */
interface WireWord {
  word?: unknown;
  word_begin?: unknown;
  word_end?: unknown;
  time_begin?: unknown;
  time_end?: unknown;
}

interface WireSegment {
  text?: unknown;
  text_begin?: unknown;
  text_end?: unknown;
  time_begin?: unknown;
  time_end?: unknown;
  timestamped_words?: unknown;
}

function toWords(raw: unknown): TimedWord[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const w = entry as WireWord;
    if (typeof w.word !== "string" || typeof w.time_begin !== "number") return [];
    return [
      {
        word: w.word,
        wordBegin: Number(w.word_begin) || 0,
        wordEnd: Number(w.word_end) || 0,
        timeBegin: w.time_begin,
        timeEnd: Number(w.time_end) || 0,
      },
    ];
  });
}

async function resolveSubtitles(url: string | undefined, signal: AbortSignal): Promise<SubtitleSegment[]> {
  if (!url) return [];
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return [];
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      const segment = entry as WireSegment;
      if (typeof segment.text !== "string" || typeof segment.time_begin !== "number") return [];
      return [
        {
          text: segment.text,
          textBegin: Number(segment.text_begin) || 0,
          textEnd: Number(segment.text_end) || 0,
          timeBegin: segment.time_begin,
          timeEnd: Number(segment.time_end) || 0,
          words: toWords(segment.timestamped_words),
        },
      ];
    });
  } catch {
    return [];
  }
}

function bodyFor(text: string, settings: VoiceSettings, voice: Record<string, unknown>) {
  return JSON.stringify({
    model: settings.model,
    text,
    stream: false,
    // `word` rather than `word_streaming`: word_streaming is only valid when
    // streaming, and this call is not streaming. It still returns
    // `timestamped_words`, which is the part karaoke needs.
    subtitle_enable: true,
    subtitle_type: "word",
    output_format: "hex",
    language_boost: settings.languageBoost,
    voice_setting: voice,
    audio_setting: {
      sample_rate: settings.sampleRate,
      bitrate: settings.bitrate,
      format: settings.format,
      channel: settings.channel,
    },
    ...(settings.pronunciationDict.length > 0
      ? { pronunciation_dict: { tone: settings.pronunciationDict } }
      : {}),
  });
}

/**
 * A call that never reached the service.
 *
 * A refused connection, a DNS failure and a dropped socket all surface as a bare
 * `TypeError: fetch failed` with the real cause on `.cause`, and every one of
 * them is transient. Left alone they would reach the route as an unrecognised
 * error and be reported as a permanent 502, which tells the learner the feature
 * is broken when it is the network's day off. An abort is the one transport
 * outcome that is not a failure to report: it means the caller left.
 */
async function post(url: string, apiKey: string, body: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new TtsError("The voice call was cancelled.", 0, false);
    }
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new TtsError(
      cause ? `The voice service was unreachable (${cause}).` : "The voice service was unreachable.",
      0,
      true,
    );
  }
}

/**
 * One call to the voice service. No caching, no retry — `speak` owns both.
 */
export async function synthesize(
  text: string,
  settings: VoiceSettings,
  signal: AbortSignal,
): Promise<Omit<Synthesis, "synthesized">> {
  let apiKey: string;
  try {
    apiKey = requireApiKey();
  } catch (error) {
    throw new TtsError(error instanceof Error ? error.message : "No API key.", 0, false);
  }

  const voice: Record<string, unknown> = {
    voice_id: settings.voiceId,
    speed: settings.speed,
    vol: settings.volume,
    pitch: settings.pitch,
  };
  if (settings.emotion) voice.emotion = settings.emotion;

  const response = await post(baseUrl(), apiKey, bodyFor(text, settings, voice), signal);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new TtsError(
      `The voice call failed (HTTP ${response.status}). ${detail.slice(0, 200)}`,
      response.status,
      response.status >= 500,
    );
  }

  const payload = (await response.json()) as ApiResponse;

  // The one check that matters. A bad key, a bad voice id and a bad emotion all
  // arrive here as HTTP 200 with this number set.
  const code = payload.base_resp?.status_code;
  if (code !== 0) {
    const known = statusFor(Number(code), payload.base_resp?.status_msg || "");
    throw new TtsError(known.message, Number(code) || 0, known.retryable);
  }

  const hex = payload.data?.audio;
  if (typeof hex !== "string" || hex.length === 0) {
    throw new TtsError("The voice call returned no audio.", 0, true);
  }
  const audio = Buffer.from(hex, "hex");
  if (audio.length === 0) {
    throw new TtsError("The voice call returned audio that did not decode.", 0, true);
  }

  // A line with no `subtitle_file` at all is a line the service chose not to
  // time. One that offered a URL and then failed to serve it is a line we lost
  // timings for, and the difference decides whether the entry is trustworthy to
  // a future karaoke build.
  const offered = typeof payload.data?.subtitle_file === "string" && payload.data.subtitle_file.length > 0;
  const subtitles = await resolveSubtitles(payload.data?.subtitle_file, signal);

  return {
    audio,
    subtitles,
    subtitlesResolved: !offered || subtitles.length > 0,
    usageCharacters: Number(payload.extra_info?.usage_characters) || 0,
    audioLengthMs: Number(payload.extra_info?.audio_length) || 0,
  };
}

/**
 * Speak a line, from cache when possible.
 *
 * The cache is checked first and written after, so the second playthrough of any
 * line is free. Nothing in here knows what a turn is.
 */
export async function speak(text: string, signal: AbortSignal): Promise<Synthesis> {
  const trimmed = text.trim();
  if (!trimmed) throw new TtsError("Nothing to speak.", 0, false);
  if (trimmed.length > MAX_CHARS) {
    throw new TtsError(
      `That line is ${trimmed.length} characters; the voice service takes at most ${MAX_CHARS}.`,
      0,
      false,
    );
  }

  const settings = voiceSettings();
  const key = await cacheKey(trimmed, settings);

  const hit = await readEntry(key);
  if (hit) return { ...hit, synthesized: false };

  const fresh = await synthesize(trimmed, settings, signal);
  await writeEntry(key, {
    audio: fresh.audio,
    subtitles: fresh.subtitles,
    subtitlesResolved: fresh.subtitlesResolved,
    usageCharacters: fresh.usageCharacters,
    audioLengthMs: fresh.audioLengthMs,
  });
  return { ...fresh, synthesized: true };
}

/**
 * The cache key: a hash of every setting that changes the audio, plus the text.
 *
 * Because the settings are hashed rather than versioned, changing an env var
 * invalidates exactly the affected entries and nothing else, with no manual
 * purge to forget.
 */
async function cacheKey(text: string, settings: VoiceSettings): Promise<string> {
  return createHash("sha256")
    .update(JSON.stringify([settings, text]))
    .digest("hex");
}
