import { randomUUID } from "node:crypto";
import type { FumbleReason, Marker, MarkerKind } from "@/lib/types";

/**
 * The model answers in two parts: the partner's line, and the annotations that
 * go with it.
 *
 * Splitting them this way is what makes the reply streamable. The prose is
 * already on screen by the time the annotations arrive, and the annotations are
 * applied to a string that has not moved. If the annotations were inline, the
 * first sentence would either have to wait for them or would render with raw
 * markup in it.
 *
 * The annotations are not asked for as JSON fields. A small model asked for
 * `{"natural": "..."}` copies `{"natural": ""}` straight out of the example in
 * the prompt and never fills it in. A line it is told to write after its reply
 * is a shape it can actually produce, so the quiet correction is a line and the
 * inline markers stay in the fenced block, where they are reliable.
 *
 * Fumbles ride the same block as markers. They are not markers — they are stored
 * separately on the Fumble Deck — but they share the streaming shape so the same
 * call still produces everything the app needs to show. The deck is what makes
 * silent regressions visible.
 *
 * Drill rides alongside them. A drill is the one case where the partner breaks
 * character to ask the learner to retry a phrase, so its decision belongs in the
 * same block — the model has just classified the fumbles, and naming the one
 * worth interrupting over is a continuation of that judgement, not a separate
 * step.
 */

const FENCE = "```";
/** The line the partner writes the quiet correction on, if there is one. */
const CORRECTION = /^修正[:：][ \t]*/;
/**
 * The same marker, not yet complete: a line holding nothing but the start of it.
 *
 * Held back rather than shown, because the streaming caller only ever moves
 * forward — it emits `prose.slice(sent)` and never retracts. A bare `修` read as
 * prose is a character on the learner's screen that the next chunk cannot take
 * back, so a half-written marker is withheld until it is known to be one. The
 * held-back set is every prefix of the marker down to a single character, since
 * a model streams the word in whatever pieces it likes and a one-character
 * prefix is the one that arrives.
 *
 * A line that merely *starts* with `修` is not held back: it is released whole as
 * soon as it grows past the marker, so `修理の件ですが` is prose and always was.
 */
const PARTIAL_CORRECTION = /^修[正]?[:：]?[ \t]*$/;

export interface ParsedReply {
  /**
   * The partner's line, with the metadata block removed.
   *
   * The quiet correction is off this string too, unless it was the only thing
   * the model wrote — then it *is* the partner's line, and it is not repeated as
   * `naturalPhrasing`. See `splitReply`.
   */
  text: string;
  naturalPhrasing: string | null;
  markers: Marker[];
  /**
   * Fumbles caught during this exchange. Empty for an opening turn, where the
   * learner has not spoken, and for the rare turn whose metadata block the model
   * dropped. Each entry has a surface that may be the empty string for an
   * abandoned turn — the deck still gains the moment, no marker is rendered.
   */
  fumbles: ParsedFumble[];
  /**
   * A drill the model has decided to issue, or null. The natural form is what
   * the partner is asking the learner to retry — a Japanese phrase that should
   * already appear as the `natural` field of one of the fumbles just reported.
   * A drill with no matching fumble is preserved rather than dropped: the
   * partner chose to break character for it, and erasing the decision would
   * discard the only signal the model had for how much it wanted this.
   */
  drill: ParsedDrill | null;
  /**
   * Deck words the learner just produced unprompted, as their natural forms.
   *
   * Each entry matches a deck `natural` exactly. An empty array is the common
   * case; a non-empty array triggers the deck-clearance write inside the turn
   * transaction so the rail shrinks visibly on the same commit.
   *
   * Empty for the opening turn (the learner has not spoken) and for any turn
   * whose metadata block the model dropped.
   */
  produced: string[];
}

export interface ParsedDrill {
  natural: string;
}

export interface ParsedFumble {
  surface: string;
  natural: string;
  reason: FumbleReason;
}

interface RawMarker {
  surface?: unknown;
  kind?: unknown;
  reading?: unknown;
  example?: unknown;
  meaning?: unknown;
}

interface RawFumble {
  surface?: unknown;
  natural?: unknown;
  reason?: unknown;
}

interface RawDrill {
  natural?: unknown;
}

interface RawProduced {
  natural?: unknown;
}

const KINDS: ReadonlySet<string> = new Set<MarkerKind>([
  "new",
  "revisit",
  "fumble",
  "grammar",
  "deck",
]);

const REASONS: ReadonlySet<string> = new Set<FumbleReason>([
  "abandoned",
  "compressed",
  "hedged",
  "wrong-form",
]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Cut the raw stream into the partner's line, the quiet correction, and the
 * metadata block.
 *
 * Called against everything received so far, not against a single delta: both
 * the correction line and the fence can open across a chunk boundary, and the
 * partner's line never contains either. Trimming is left to the caller, because
 * the streaming caller needs an untrimmed prefix it can measure against how much
 * it has already sent.
 *
 * What comes back is one of three shapes. The designed one is a partner line
 * with the quiet correction after it, and the correction comes back separately
 * to be hung on the learner's turn. A reply with no correction line is the
 * common case. The third is a reply that is nothing but a correction, where the
 * correction *is* the line — see below.
 */
export function splitReply(raw: string): {
  prose: string;
  correction: string | null;
  metadata: string | null;
} {
  const fence = raw.indexOf(FENCE);
  /**
   * The visible head, with the two things a stream can end on mid-shape held
   * back, because the streaming caller cannot un-send what it has shown.
   *
   * A fence still opening — one or two backticks so far — is not prose. Three is
   * a fence, and `indexOf` has already found it. The cost is a partner line that
   * genuinely ends in one or two backticks losing them, which the prompt's
   * "Japanese only, no markup" rules make not a thing that happens, against every
   * turn otherwise opening with a flash of backticks. And a trailing newline is
   * not prose either: it is the model saying a new line is starting, and that line
   * may yet turn out to be a correction marker, which would withdraw the newline
   * and leave the last real character of the line unsent. Internal newlines are
   * left alone; only the ones with nothing after them are dropped.
   */
  const head = (fence < 0 ? raw.replace(/`{1,2}$/, "") : raw.slice(0, fence)).replace(/\n+$/, "");
  const metadata = fence < 0 ? null : raw.slice(fence + FENCE.length);

  const lines = head.split("\n");

  // The line the marker is on, and what is left of it once the marker is off.
  // `rest` is null both for a marker that is still being typed and for one with
  // nothing after it: neither is a correction, and in both cases the marker line
  // is dropped from the prose.
  let cut = lines.length;
  let rest: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = CORRECTION.exec(line);
    if (match) {
      cut = i;
      rest = line.slice(match[0].length).trim() || null;
      break;
    }
    // Only the last line can still be growing, so only the last line can be a
    // half-written marker. A newline through the line means the model has moved
    // on, and whatever it wrote there is prose.
    if (i === lines.length - 1 && PARTIAL_CORRECTION.test(line)) {
      cut = i;
      break;
    }
  }

  const before = lines.slice(0, cut).join("\n");

  if (rest === null) {
    // Nothing to hand back as a correction, so what came before is the prose.
    // With nothing cut this is the head unchanged.
    return { prose: showable(before), correction: null, metadata };
  }

  if (before.trim() !== "") {
    // The designed shape: a partner line, then the quiet correction under it.
    // Only the rest of that line. Taking the lines under it too would swallow
    // prose written on a later line into the correction, which is exactly the
    // wrong-correction case the guard downstream exists to catch.
    return { prose: showable(before), correction: rest, metadata };
  }

  /**
   * A reply that is nothing but a correction. The prompt asks for the partner's
   * line first and the correction after it, and says so in three places, so this
   * is a model that answered in the wrong order. It is not an error: what it
   * wrote is a Japanese sentence in the persona's voice, which is the whole
   * content of a turn, and the correction is asked for as a sentence usable
   * as-is. Treating it as an empty reply threw away an exchange the partner did
   * have and showed the learner an error for a turn where something was said, so
   * the correction becomes the line instead.
   *
   * It is deliberately not also returned as `correction`. The learner is reading
   * it as the partner's line, and the same sentence rendered a second time as
   * the natural phrasing of the same turn is the duplication that follows — the
   * one thing a correction cannot be is a line the learner has already read.
   *
   * This amends ADR 0002, which recorded the partner's line and the correction
   * as always separate. See the consequences added there.
   */
  const after = unmasked(lines.slice(cut + 1));
  return { prose: showable(after ? `${rest}\n${after}` : rest), correction: null, metadata };
}

/**
 * The lines under the marker, with any further marker taken off them.
 *
 * The model was asked for one correction line and has written two. The first has
 * become the partner's line, and the second is still an annotation — a raw `修正:`
 * is the one string ADR 0002 guarantees never reaches the learner, and it must not
 * reach them through the back door of a turn that was already rescued. Its
 * sentence is kept, because it is Japanese the learner can act on and this turn is
 * already committed to keeping what the model wrote; only the marker goes.
 */
function unmasked(lines: string[]): string {
  const kept = lines.map((line) => {
    const match = CORRECTION.exec(line);
    return match ? line.slice(match[0].length).trim() : line;
  });
  // The last line is still growing, so a bare `修` there has not decided whether
  // it is prose or the start of another marker. Withhold it rather than show a
  // prefix that completing it would take back.
  if (PARTIAL_CORRECTION.test(lines[lines.length - 1] ?? "")) kept.pop();
  return kept.filter((line) => line !== "").join("\n");
}

/**
 * Prose the client can be sent without owing the learner a retraction.
 *
 * Whitespace at the end is never content, and it is the one part of the stream
 * that is not yet decided: a trailing blank line can be the line *before* a
 * correction, and a correction arriving after it re-decides what the prose is.
 * Sent as-is, the blank has already gone to the client by the time the correction
 * lands, the correction then shortens the prose, and the stream is left holding a
 * marker and a newline that the committed turn no longer contains. Ending the
 * prose on its last real character keeps every delta appendable — the model can
 * keep writing, but it can never take back.
 */
function showable(prose: string): string {
  return prose.replace(/\s+$/, "");
}

/**
 * The part of the raw stream the learner is allowed to see so far. Deltas carry
 * this and nothing else, so a half-written correction or a half-written JSON
 * block never reaches the transcript.
 */
export function visibleProse(raw: string): string {
  return splitReply(raw).prose;
}

function parseMarkers(text: string, raw: unknown): Marker[] {
  if (!Array.isArray(raw)) return [];

  const candidates: { marker: Omit<Marker, "id" | "start" | "end">; at: number }[] = [];
  for (const item of raw as RawMarker[]) {
    const surface = str(item?.surface);
    const kind = str(item?.kind);
    if (!surface || !KINDS.has(kind)) continue;
    const at = text.indexOf(surface);
    // A surface that is not in the text is dropped rather than misplaced. The
    // model is told the surface must appear verbatim and occasionally does not
    // manage it; a marker with nowhere to sit is a marker the renderer would
    // have to invent a position for.
    if (at < 0) continue;
    candidates.push({
      marker: {
        surface,
        kind: kind as MarkerKind,
        reading: str(item?.reading),
        meaning: str(item?.meaning),
        example: str(item?.example),
      },
      at,
    });
  }

  // Earliest first, longest at a tie, and never let two markers overlap. The
  // ranges are resolved here, server-side, so a reloaded session renders
  // identically to the live stream.
  candidates.sort((a, b) => a.at - b.at || b.marker.surface.length - a.marker.surface.length);

  const placed: Marker[] = [];
  let cursor = 0;
  for (const c of candidates) {
    let at = c.at;
    // Two markers for the same surface in one reply — a word introduced and then
    // needed again a sentence later — both resolve to the first occurrence and
    // would collide here. The second one takes the next occurrence instead of
    // being dropped, because the reuse is the whole point of the New Word loop:
    // dropping it would leave the transcript showing a first meeting and nothing
    // else, and the debrief would ask the learner to recall a word the app has
    // no record of needing twice.
    if (at < cursor) {
      const next = text.indexOf(c.marker.surface, cursor);
      if (next < 0) continue;
      at = next;
    }
    placed.push({
      id: randomUUID(),
      ...c.marker,
      start: at,
      end: at + c.marker.surface.length,
    });
    cursor = at + c.marker.surface.length;
  }
  return placed;
}

/** Punctuation and spacing are not the point of a correction. */
function normalise(s: string): string {
  return s.replace(/[\s。、！？!?「」『』,.]/g, "");
}

/**
 * The quiet correction, or nothing.
 *
 * A correction line that is not a correction is worse than no line: it costs the
 * learner a glance at the exchange they are in the middle of, and a wrong one
 * teaches the wrong thing. Four things are dropped here. The partner's opening
 * line has nothing to correct, since the learner has not spoken. A model asked
 * to be helpful will sometimes restate its own reply instead of rephrasing the
 * learner, so a line that matches the partner's own words goes. And it will
 * sometimes hand back the learner's own words, or an explanation instead of a
 * phrasing, so anything that does not actually differ from what was typed goes
 * too.
 */
function naturalPhrasingFor(
  natural: string,
  whatLearnerSaid: string | null,
  whatPartnerSaid: string,
): string | null {
  if (!natural || whatLearnerSaid === null) return null;
  if (normalise(natural) === normalise(whatLearnerSaid)) return null;
  if (whatLearnerSaid.includes(natural)) return null;
  if (normalise(whatPartnerSaid).includes(normalise(natural))) return null;
  return natural;
}

/**
 * The fumbles the model reported, with each field narrowed to what it actually is.
 *
 * A missing `reason`, an unknown one, or a missing `natural` drops the entry. A
 * `surface` that is not a string becomes an empty string, which is the
 * abandoned-turn case — the deck gains a moment, no marker is rendered. Dropping
 * a malformed entry is the right move because the deck is the only honest signal
 * we have that detection is alive, and a phantom word with no natural form is
 * something the learner cannot act on.
 */
function parseFumbles(raw: unknown): ParsedFumble[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedFumble[] = [];
  for (const item of raw as RawFumble[]) {
    const natural = str(item?.natural);
    const reason = str(item?.reason);
    if (!natural || !REASONS.has(reason)) continue;
    out.push({
      surface: str(item?.surface),
      natural,
      reason: reason as FumbleReason,
    });
  }
  return out;
}

/**
 * The drill the model decided to issue, or null.
 *
 * A drill is `{"natural": "..."}` with the natural form in Japanese. A missing
 * `natural` or a non-string one drops the drill, because the only thing the
 * drill field carries is what to retry. A model that decides to drill but
 * leaves the natural blank has not finished the decision, and discarding it
 * costs less than a drill the renderer cannot display.
 */
function parseDrill(raw: unknown): ParsedDrill | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as RawDrill;
  const natural = str(obj?.natural);
  if (!natural) return null;
  return { natural };
}

/**
 * The deck words the learner produced unprompted, as their natural forms.
 *
 * Each entry is a Japanese phrase that should match a `natural` field already on
 * the Fumble Deck. A non-string or empty natural is dropped rather than trusted:
 * the deck-clearance write keys on it exactly, and a phantom entry would clear
 * nothing while looking like it cleared something.
 *
 * Duplicates are collapsed: two model calls clearing the same word in one turn is
 * a single deck-shrink event, and the rail counts it once.
 */
function parseProduced(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw as RawProduced[]) {
    const natural = str(item?.natural);
    if (!natural) continue;
    seen.add(natural);
  }
  return [...seen];
}

/**
 * Turn a completed stream into a displayable turn.
 *
 * A missing or malformed metadata block is not a failure. The turn still
 * happened; it just arrives without inline markers. Failing here would throw
 * away a good exchange over a cosmetic defect. The same applies to fumbles and
 * drills: a turn with no fumble block is a turn with no fumbles, not a turn
 * that broke, and a turn with no drill block is a turn that did not drill. A turn
 * with no `produced` block is a turn that produced no deck words, which is the
 * common case and is not a failure either.
 */
export function parseReply(raw: string, whatLearnerSaid: string | null = null): ParsedReply {
  const { prose, correction, metadata } = splitReply(raw);
  const text = prose.trim();
  const natural = naturalPhrasingFor(correction?.trim() ?? "", whatLearnerSaid, text);

  if (metadata === null) {
    return { text, naturalPhrasing: natural, markers: [], fumbles: [], drill: null, produced: [] };
  }

  // The fence is followed by a language tag on some responses.
  const body = metadata.replace(/^\s*(?:json)?\s*/, "");
  const end = body.lastIndexOf(FENCE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(end >= 0 ? body.slice(0, end) : body);
  } catch {
    return { text, naturalPhrasing: natural, markers: [], fumbles: [], drill: null, produced: [] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { text, naturalPhrasing: natural, markers: [], fumbles: [], drill: null, produced: [] };
  }

  const obj = parsed as { markers?: unknown; fumbles?: unknown; drill?: unknown; produced?: unknown };
  return {
    text,
    naturalPhrasing: natural,
    markers: parseMarkers(text, obj.markers),
    fumbles: parseFumbles(obj.fumbles),
    drill: parseDrill(obj.drill),
    produced: parseProduced(obj.produced),
  };
}
