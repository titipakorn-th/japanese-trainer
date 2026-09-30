import { randomUUID } from "node:crypto";
import type { Marker } from "@/lib/types";

/**
 * A marker that has been matched to a position in some text, but not yet had its
 * character range or id assigned. The placement loop fills both in.
 */
interface PlacedCandidate {
  marker: Omit<Marker, "id" | "start" | "end">;
  at: number;
}

/**
 * Place a set of candidate markers against their text and return the resolved
 * `Marker`s.
 *
 * Two anchors must always agree:
 *
 * - **Earliest first, longest on a tie.** A short word earlier in the text
 *   wins over a long one inside it; on equal positions, the longer surface
 *   wins, so `会計` is preferred over `会` when both start at the same index.
 * - **No overlaps.** A marker that would land inside an already-placed marker
 *   is dropped, because two markers on top of each other render as one with
 *   the wrong surface. The dropped one was less informative anyway: the
 *   learner can still see the longer surface in the gloss.
 *
 * The kernel is shared between partner-line markers (resolved against the
 * partner's reply in `parse.ts`) and learner-turn fumble markers (resolved
 * against the learner's text in `fumbleMarkers.ts`). The two resolve against
 * different texts but the placement algorithm is the same — a reloaded
 * session has to render byte-identically whichever side of the conversation
 * it landed on.
 */
export function placeMarkers(candidates: PlacedCandidate[]): Marker[] {
  // Earliest first, longest at a tie.
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

/** A `PlacedCandidate` minus the position, for callers that want to bind the position later. */
export type CandidateMarker = Omit<Marker, "id" | "start" | "end">;
