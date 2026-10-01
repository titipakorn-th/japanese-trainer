/**
 * A disk cache for synthesised speech.
 *
 * The audio is a pure function of the text and the voice settings, so it caches
 * perfectly — the only reason it would not is if we paid for it twice, and
 * speech is billed per character.
 *
 * Two files per entry, not one, and that is the point: the audio alone is not
 * the artifact. The subtitle payload travels with it because caching only the
 * audio would mean paying twice for every line the moment word-level
 * highlighting is built (ADR 0007).
 *
 * Eviction is least-recently-used by file mtime. A read touches the file, so
 * "least recently used" is the same thing as "oldest mtime" and needs no access
 * log to keep honest.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SubtitleSegment } from "./tts";

export interface CacheEntry {
  audio: Buffer;
  subtitles: SubtitleSegment[];
  /**
   * Whether the subtitle payload was actually fetched, as opposed to the fetch
   * having failed and been swallowed.
   *
   * This exists because the cache key is the text and the voice settings, and
   * neither knows anything went wrong. A transient failure to resolve the
   * subtitles would otherwise be written as an empty array and then served as a
   * hit forever after, so the timings that karaoke highlighting needs would be
   * missing for exactly the lines that failed once — permanently, with no way to
   * tell a line that has no words from a line whose fetch died.
   */
  subtitlesResolved: boolean;
  usageCharacters: number;
  audioLengthMs: number;
}

interface Sidecar {
  subtitles: SubtitleSegment[];
  subtitlesResolved: boolean;
  usageCharacters: number;
  audioLengthMs: number;
  cachedAt: number;
}

/**
 * The cache lives beside the app, not under `data/`.
 *
 * `data/` holds the SQLite store and is ignored by extension, not by directory,
 * so MP3s written there would be committed by the next `git add -A`.
 * `.tts-cache/` is already in `.gitignore` for exactly this.
 */
const CACHE_DIR = path.join(process.cwd(), ".tts-cache");

export { CACHE_DIR };

/** Below this, the cache is costing more to manage than it saves. */
const MIN_CAP_BYTES = 8 * 1024 * 1024;

function capBytes(): number {
  const mb = Number(process.env.TTS_CACHE_MB);
  const resolved = Number.isFinite(mb) && mb > 0 ? mb : 256;
  return Math.max(MIN_CAP_BYTES, resolved * 1024 * 1024);
}

function audioPath(key: string): string {
  return path.join(CACHE_DIR, `${key}.mp3`);
}

function sidecarPath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function ensureDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * A read that fails is a miss, never an error.
 *
 * A cache is an optimisation; if the disk is full, the directory was deleted, or
 * a file is half-written, the learner should still hear the line. Every failure
 * here degrades to a miss so the caller synthesises instead.
 */
export async function readEntry(key: string): Promise<CacheEntry | null> {
  try {
    const audio = readFileSync(audioPath(key));
    const sidecar = JSON.parse(readFileSync(sidecarPath(key), "utf8")) as Sidecar;
    const now = new Date();
    utimesSync(audioPath(key), now, now);
    utimesSync(sidecarPath(key), now, now);
    return {
      audio,
      subtitles: Array.isArray(sidecar.subtitles) ? sidecar.subtitles : [],
      // An entry written before this field existed cannot be trusted to have
      // resolved its subtitles, so it reads as unresolved rather than as empty.
      subtitlesResolved: sidecar.subtitlesResolved === true,
      usageCharacters: Number(sidecar.usageCharacters) || 0,
      audioLengthMs: Number(sidecar.audioLengthMs) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Write through a temporary name and rename into place.
 *
 * A crash part-way through a direct write would leave a truncated MP3 that reads
 * as a hit forever after. A rename is atomic, so a reader sees either the old
 * entry or the new one.
 */
export async function writeEntry(key: string, entry: CacheEntry): Promise<void> {
  try {
    ensureDir();
    const sidecar: Sidecar = {
      subtitles: entry.subtitles,
      subtitlesResolved: entry.subtitlesResolved,
      usageCharacters: entry.usageCharacters,
      audioLengthMs: entry.audioLengthMs,
      cachedAt: Date.now(),
    };
    const staged = `${audioPath(key)}.${process.pid}.tmp`;
    writeFileSync(staged, entry.audio);
    writeFileSync(`${sidecarPath(key)}.${process.pid}.tmp`, JSON.stringify(sidecar));
    renameSync(staged, audioPath(key));
    renameSync(`${sidecarPath(key)}.${process.pid}.tmp`, sidecarPath(key));
    evict();
  } catch {
    // A cache that cannot be written is a slower app, not a broken one.
  }
}

interface Candidate {
  key: string;
  mtimeMs: number;
  bytes: number;
}

function scan(): { total: number; entries: Candidate[] } {
  let names: string[];
  try {
    names = readdirSync(CACHE_DIR);
  } catch {
    return { total: 0, entries: [] };
  }

  const seen = new Set<string>();
  const entries: Candidate[] = [];
  let total = 0;

  for (const name of names) {
    if (!name.endsWith(".mp3")) continue;
    const key = name.slice(0, -4);
    try {
      const stat = statSync(path.join(CACHE_DIR, name));
      seen.add(key);
      entries.push({ key, mtimeMs: stat.mtimeMs, bytes: stat.size });
      total += stat.size;
    } catch {
      // Vanished between readdir and stat. Nothing to do.
    }
  }

  // An MP3 with no sidecar is a half-finished write from an older run, and a
  // sidecar with no MP3 is its orphan. Neither is ever a usable hit, so neither
  // is worth the bytes. Their size is deliberately *not* added to `total`: the
  // bytes are already gone by the time eviction runs, and counting them would
  // make the budget start too high and evict live entries to pay for files that
  // no longer exist.
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -5);
    if (seen.has(key)) continue;
    rmSync(path.join(CACHE_DIR, name), { force: true });
  }

  return { total, entries };
}

/**
 * Drop the least recently used entries until the cache fits its cap.
 *
 * A single pass rather than a loop: entries are sorted oldest-first and taken
 * until the budget is met, and if a single entry is larger than the cap the
 * budget never met and the pass ends by having deleted everything, which is the
 * right answer for a cache that cannot hold its own contents.
 */
function evict(): void {
  const cap = capBytes();
  const { total, entries } = scan();
  if (total <= cap) return;

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let running = total;
  for (const entry of entries) {
    if (running <= cap) break;
    rmSync(audioPath(entry.key), { force: true });
    rmSync(sidecarPath(entry.key), { force: true });
    running -= entry.bytes;
  }
}

export interface CacheStats {
  entries: number;
  bytes: number;
  capBytes: number;
  dir: string;
}

/** What the cache is holding, for the probe script and for looking at by hand. */
export async function cacheStats(): Promise<CacheStats> {
  const { total, entries } = scan();
  return { entries: entries.length, bytes: total, capBytes: capBytes(), dir: CACHE_DIR };
}
