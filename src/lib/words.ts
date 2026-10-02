import type { Marker, Turn } from "./types";

/**
 * Reading a set of turns for the New Words in them.
 *
 * A New Word is met inside a sentence, so it arrives as a marker on a turn
 * rather than as a row of its own — which means "how many new words were in
 * this session" is a question about annotations, and it is asked in three
 * places: the sprint debrief, the end-of-session summary, and the start screen's
 * "last time" line. One definition of the count, so the three cannot disagree
 * about what a word is or count the same word twice.
 *
 * Distinct surfaces, first met first, so a word the partner reuses three turns
 * later is still the one word the learner met.
 */
export function distinctNewWords(turns: Turn[]): Pick<Marker, "surface" | "reading" | "meaning">[] {
  const seen = new Set<string>();
  const out: Pick<Marker, "surface" | "reading" | "meaning">[] = [];
  for (const turn of turns) {
    for (const marker of turn.markers) {
      if (marker.kind !== "new" || seen.has(marker.surface)) continue;
      seen.add(marker.surface);
      out.push({ surface: marker.surface, reading: marker.reading, meaning: marker.meaning });
    }
  }
  return out;
}
