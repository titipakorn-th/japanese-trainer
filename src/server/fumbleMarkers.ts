import { randomUUID } from "node:crypto";
import type { Marker } from "@/lib/types";
import type { ParsedFumble } from "./parse";

/**
 * Turn fumbles into inline markers on the learner's turn.
 *
 * The marker system anchors `surface` to a character range in a turn's text.
 * Partner-line markers find their surface in the partner's reply; fumble markers
 * find theirs in the learner's reply, which is the whole reason this resolver
 * lives next to the parser rather than inside it — the parser knows about the
 * partner's text, not the learner's.
 *
 * A fumble whose `surface` is empty (an abandoned turn) produces no marker:
 * there is nothing to underline. The moment still lands on the deck, and the
 * sprint debrief still lists it. A `surface` that does not appear in the
 * learner's text is dropped rather than misplaced, which is the same rule
 * `parseMarkers` applies for partner-line markers — a reloaded session renders
 * byte-identically, and a marker the renderer cannot anchor is not one a learner
 * can act on.
 */
export function fumbleMarkers(learnerText: string, fumbles: ParsedFumble[]): Marker[] {
  if (fumbles.length === 0) return [];

  const candidates: { marker: Omit<Marker, "id" | "start" | "end">; at: number }[] = [];
  for (const f of fumbles) {
    if (!f.surface) continue;
    const at = learnerText.indexOf(f.surface);
    if (at < 0) continue;
    candidates.push({
      marker: {
        surface: f.surface,
        kind: "fumble",
        // Reading of the surface is omitted: the surface is often English, and
        // the gloss carries the natural form in `meaning`, which is what the
        // learner wants to read.
        reading: "",
        meaning: f.natural,
        example: "",
      },
      at,
    });
  }

  // Earliest first, longest on a tie, no overlap. Same ordering rule as
  // `parseMarkers`, kept consistent so the inline layout feels uniform across
  // turns from either side of the conversation.
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
