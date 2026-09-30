import { humanDuration, humanMs, meanMs, responseTimes } from "@/lib/measure";
import { stanceTrail } from "./stance";
import { getSprintFumbles } from "./fumbles";
import type {
  Debrief,
  DebriefLine,
  Fumble,
  Marker,
  Sprint,
  SprintEnding,
  Turn,
  WordLedger,
} from "@/lib/types";

/**
 * What happened in a sprint, in a few lines the learner can act on.
 *
 * This is built only from turns that were actually committed, never from the
 * model's opinion of the learner. That is a deliberate constraint: a debrief is
 * the one screen where a learner is most likely to believe the app, and a
 * flattering or wrong line here costs more than a missing one. So it counts what
 * was said, what was corrected, and how long the learner took — and where the
 * numbers are thin it says nothing rather than guessing.
 *
 * Fumbles ride with the rest of the debrief. The card lists every moment the
 * deck captured during this sprint, paired with the situation it happened in,
 * so the learner can see what they reached for and what would have been
 * natural. The drill of the worst one lives in its own slice.
 */

/** One word the sprint met, and whether the session needed it a second time. */
type RecalledWord = Pick<Marker, "surface" | "reading" | "meaning"> & {
  kind: "new" | "deck";
  seenAgain: boolean;
};

/**
 * The sprint's words, with whether each was needed a second time.
 *
 * `seenAgain` is not decoration. A word the partner used once is a word the learner
 * can recognise; a word used again later, in a different sentence, is one they can
 * be asked to produce. It is what lets the card say "this is a recall" rather than
 * "this is a list", and it is read off the ledger rather than assumed from a count.
 *
 * Deck words are in here alongside New Words, and the distinction is carried on
 * each entry rather than inferred. They are the half of the budget the learner has
 * failed before, so they are the half where recall is most worth attempting — and
 * CONTEXT.md gives "New Word" a definition (a word introduced for the first time
 * in a session) that a deck word does not satisfy, so a card that called them all
 * New Words would be using the product's own word for something it does not mean.
 */
function distinctWords(turns: Turn[], ledger: WordLedger): RecalledWord[] {
  const seen = new Set<string>();
  const out: RecalledWord[] = [];
  for (const turn of turns) {
    for (const marker of turn.markers) {
      if (marker.kind !== "new" && marker.kind !== "deck") continue;
      if (seen.has(marker.surface)) continue;
      seen.add(marker.surface);
      out.push({
        surface: marker.surface,
        reading: marker.reading,
        meaning: marker.meaning,
        kind: marker.kind,
        // `revisited`, not `slots`. The grid the rail draws is capped at the budget,
        // and a word met past it is in this debrief but absent from the grid — so
        // asking the grid would report "not needed again" for precisely the words an
        // overrun produced, which is the one case where the claim matters most. Read
        // at the boundary, so it reflects the second meetings that had happened by
        // then and not ones still to come.
        seenAgain: ledger.revisited.includes(marker.surface),
      });
    }
  }
  return out;
}

/** The quiet corrections, paired with what the learner said instead. */
function quietCorrections(turns: Turn[]): { said: string; natural: string }[] {
  return turns
    .filter((t) => t.role === "learner" && t.naturalPhrasing)
    .map((t) => ({ said: t.text, natural: t.naturalPhrasing as string }));
}

function endsOnPartner(turns: Turn[]): boolean {
  return turns[turns.length - 1]?.role === "partner";
}

/**
 * Hesitation, split into the first half and the second.
 *
 * The product's claim is that this number gets shorter with practice, so a
 * single average hides the only thing worth looking at. It is reported only when
 * there are enough measurements on both sides to mean anything.
 */
function trend(times: number[]): string | null {
  if (times.length < 4) return null;
  const half = Math.floor(times.length / 2);
  const first = meanMs(times.slice(0, half));
  const second = meanMs(times.slice(half));
  if (first === null || second === null) return null;
  const delta = second - first;
  if (Math.abs(delta) < 2000) return null;
  return delta < 0
    ? `Returning faster by the end: ${humanMs(first)} early on, ${humanMs(second)} later.`
    : `Slower by the end than at the start: ${humanMs(first)} early on, ${humanMs(second)} later.`;
}

const ENDING_WORDS: Record<SprintEnding, string> = {
  budget: "ran its full length",
  "sprint-clock": "stopped on time",
  "session-clock": "stopped because the session was out of time",
  abandoned: "stopped here, by you",
  migrated: "was recorded before sessions had more than one scene to them",
};

export function buildDebrief(
  sprint: Sprint,
  turns: Turn[],
  endedBy: SprintEnding,
  now: number,
  ledger: WordLedger,
): Debrief {
  const startedAt = sprint.startedAt ?? now;
  const learnerTurns = turns.filter((t) => t.role === "learner");
  const times = responseTimes(learnerTurns);
  const avgResponseMs = meanMs(times);
  const words = distinctWords(turns, ledger);
  const corrections = quietCorrections(turns);
  // A sprint always ends on the partner's line, so the last learner turn was
  // answered by a closing rather than by a chosen stance.
  const trail = endsOnPartner(turns) ? stanceTrail(turns).slice(0, -1) : stanceTrail(turns);

  const lines: DebriefLine[] = [];

  lines.push({
    kind: "pace",
    text: `${learnerTurns.length} ${learnerTurns.length === 1 ? "turn" : "turns"} in about ${humanDuration(now - startedAt)}. It ${ENDING_WORDS[endedBy]}.`,
  });

  if (avgResponseMs !== null) {
    lines.push({ kind: "pace", text: `You took ${humanMs(avgResponseMs)} on average to answer.` });
  }
  const moved = trend(times);
  if (moved) lines.push({ kind: "pace", text: moved });

  if (words.length) {
    // The surfaces are not named here. The card's recall section shows them and
    // holds the reading and the meaning behind a tap, so listing them in this
    // line would hand over every answer before the learner has tried to produce
    // one — turning the recall back into the recognition it was built to replace.
    // Counted by source rather than totalled, because "New Word" has a definition
    // and a deck word does not meet it. A sprint with two deck words in it did not
    // meet two New Words.
    const fresh = words.filter((w) => w.kind === "new").length;
    const fromDeck = words.length - fresh;
    const again = words.filter((w) => w.seenAgain).length;
    const parts: string[] = [];
    if (fresh > 0) parts.push(`${fresh} new ${fresh === 1 ? "word" : "words"}`);
    if (fromDeck > 0) parts.push(`${fromDeck} from the Fumble Deck`);
    const subject = parts.join(" and ");

    lines.push({
      kind: "words",
      text: again
        ? `${subject} met, and ${again} of ${again === 1 ? "it" : "them"} came round again later. Try to say ${again === 1 ? "it" : "them"} back from memory below.`
        : `${subject} met, but none came round again this session — so this is a list to read, not a recall to attempt.`,
    });
  } else {
    lines.push({ kind: "words", text: "No new words in this one." });
  }

  if (corrections.length) {
    lines.push({
      kind: "corrections",
      text: `The partner rephrased ${corrections.length === 1 ? "one turn" : `${corrections.length} turns`} quietly, underneath what you said.`,
    });
  }

  // How the partner behaved, counted rather than judged. "You went quiet twice and
  // the partner slowed down both times" is a fact about both sides of the
  // exchange, and it is the line that makes the behaviour legible to a learner
  // who could not see it happening.
  //
  // A sprint's last exchange is answered by the closing line, which is not
  // stance-driven — it always runs `plain`, because a scene ending is not a
  // moment to complicate or rescue. Replaying the detector over that turn would
  // credit the partner with conduct it never chose, so the last stance is
  // dropped. Undercounting is the right way to be wrong here: a missing number
  // cannot be a false claim.
  const rescued = trail.filter((s) => s.stance === "give-word").length;
  const slowed = trail.filter((s) => s.stance === "slow").length;
  const raised = trail.filter((s) => s.stance === "harder").length;
  const notes: string[] = [];
  if (rescued) notes.push(`the partner handed over a word ${rescued === 1 ? "once" : `${rescued} times`} when you said you did not have it`);
  if (slowed) notes.push(`the partner slowed down and rephrased ${slowed === 1 ? "once" : `${slowed} times`} because you were struggling`);
  if (raised) notes.push(`the partner made it harder ${raised === 1 ? "once" : `${raised} times`} because you were keeping up`);
  if (notes.length) {
    lines.push({ kind: "note", text: `In this one, ${notes.join("; ")}.` });
  }

  return {
    sprintId: sprint.id,
    afterSeq: turns.length ? Math.max(...turns.map((t) => t.seq)) : 0,
    seq: sprint.seq,
    title: sprint.brief.persona,
    place: sprint.brief.place,
    goal: sprint.brief.goal,
    startedAt,
    endedAt: now,
    endedBy,
    turnCount: learnerTurns.length,
    avgResponseMs,
    words,
    corrections,
    fumbles: getSprintFumbles(sprint.id),
    lines,
  };
}
