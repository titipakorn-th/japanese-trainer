import { randomUUID } from "node:crypto";
import type { Marker, MarkerKind } from "@/lib/types";

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
 */

const FENCE = "```";
/** The line the partner writes the quiet correction on, if there is one. */
const CORRECTION = /^修正[:：][ \t]*/;

export interface ParsedReply {
  /** The partner's line, with the correction line and metadata block removed. */
  text: string;
  naturalPhrasing: string | null;
  markers: Marker[];
}

interface RawMarker {
  surface?: unknown;
  kind?: unknown;
  reading?: unknown;
  example?: unknown;
  meaning?: unknown;
}

const KINDS: ReadonlySet<string> = new Set<MarkerKind>(["new", "fumble", "grammar"]);

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
 */
export function splitReply(raw: string): {
  prose: string;
  correction: string | null;
  metadata: string | null;
} {
  const fence = raw.indexOf(FENCE);
  const head = fence < 0 ? raw : raw.slice(0, fence);
  const metadata = fence < 0 ? null : raw.slice(fence + FENCE.length);

  let correction: string | null = null;
  let prose = head;

  const lines = head.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = CORRECTION.exec(lines[i] ?? "");
    if (!match) continue;
    // Only the rest of that line. Taking the lines after it too would swallow
    // prose written on a later line into the correction, which is exactly the
    // wrong-correction case the guard downstream exists to catch.
    correction = (lines[i] ?? "").slice(match[0].length).trim() || null;
    prose = lines.slice(0, i).join("\n");
    break;
  }

  return { prose, correction, metadata };
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
    // A surface that is not in the text, or that the learner has already met,
    // is dropped rather than misplaced. This slice anchors a marker to the first
    // occurrence only, so a word used twice in a turn gets one marker; marking
    // every occurrence is the New Word work.
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
    if (c.at < cursor) continue;
    placed.push({
      id: randomUUID(),
      ...c.marker,
      start: c.at,
      end: c.at + c.marker.surface.length,
    });
    cursor = c.at + c.marker.surface.length;
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
 * Turn a completed stream into a displayable turn.
 *
 * A missing or malformed metadata block is not a failure. The turn still
 * happened; it just arrives without inline markers. Failing here would throw
 * away a good exchange over a cosmetic defect.
 */
export function parseReply(raw: string, whatLearnerSaid: string | null = null): ParsedReply {
  const { prose, correction, metadata } = splitReply(raw);
  const text = prose.trim();
  const natural = naturalPhrasingFor(correction?.trim() ?? "", whatLearnerSaid, text);

  if (metadata === null) {
    return { text, naturalPhrasing: natural, markers: [] };
  }

  // The fence is followed by a language tag on some responses.
  const body = metadata.replace(/^\s*(?:json)?\s*/, "");
  const end = body.lastIndexOf(FENCE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(end >= 0 ? body.slice(0, end) : body);
  } catch {
    return { text, naturalPhrasing: natural, markers: [] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { text, naturalPhrasing: natural, markers: [] };
  }

  return {
    text,
    naturalPhrasing: natural,
    markers: parseMarkers(text, (parsed as { markers?: unknown }).markers),
  };
}
