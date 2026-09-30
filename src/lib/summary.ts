import { humanDuration, humanMs, meanMs, responseTimes } from "./measure";
import { distinctNewWords } from "./words";
import type { Fumble, Marker, Session, Sprint, Turn } from "./types";

/**
 * The end-of-session account.
 *
 * A Debrief answers "what happened in this scene"; this answers "what did the
 * whole sitting look like". It is the one screen that survives the conversation
 * and can be compared against the next one, so the two numbers that matter —
 * how long the learner hesitated, and how often they walked away from a turn —
 * are reported here per Turn rather than as a single average. An average of
 * twenty answers is one number and no story; the sequence of them is the thing
 * that shows practice happening.
 *
 * Like `measure.ts` and the debrief, this is a projection of committed state and
 * never an opinion: every field is counted from turns and fumbles that are on
 * disk, and where the evidence is too thin to mean anything the field is null
 * rather than a guess. Nothing here touches the environment, so the browser can
 * import it and render the same summary the server would have.
 */

/** One learner turn's hesitation, as the summary reports it. */
export interface TurnPace {
  id: number;
  seq: number;
  /** Which sprint the turn happened in, so the summary can line up with scenes. */
  sprintSeq: number | null;
  /**
   * ms from the partner finishing to the learner submitting, or null when the
   * browser could not time it. Null is carried through rather than dropped: an
   * unmeasured turn is a real turn that happened, and quietly removing it would
   * make the learner look faster than they were.
   */
  responseMs: number | null;
}

/** How one set of words fared across the session. */
export interface DeckOutcome {
  /** Distinct natural forms fumbled at any point in this session. */
  fumbled: number;
  /** Of those, how many have since left the deck. */
  cleared: number;
  /** Of those, how many are still on it. */
  holding: number;
}

export interface SessionSummary {
  /** Every learner turn, in order, with the time it took to write. */
  pace: TurnPace[];
  /** Turns the browser timed. Turns it could not are excluded from every mean. */
  measured: number;
  /** Turns with no timing at all, so the report can be honest about coverage. */
  unmeasured: number;
  /** Mean over the measured turns, or null when none were measured. */
  meanResponseMs: number | null;
  /** Longest single measured turn, or null. The one answer that cost the most. */
  slowestMs: number | null;
  /**
   * Mean of the earlier measured half and the later one, and the difference.
   * All three stay null unless there are at least four measured turns *and* the
   * two halves differ by at least two seconds — the same two bars the debrief
   * sets. A flat session is a normal session, and reporting a zero-second
   * "trend" would invite a conclusion the transcript cannot support.
   */
  firstHalfMs: number | null;
  secondHalfMs: number | null;
  /** `secondHalfMs - firstHalfMs`. Negative means the learner got quicker. */
  deltaMs: number | null;
  /** Learner turns in the session. The denominator for every rate below. */
  learnerTurns: number;
  /** Turns the learner walked away from — an abandoned answer, nothing to read. */
  bailOuts: number;
  /** `bailOuts / learnerTurns`, 0–1. Null when there were no learner turns. */
  bailOutRate: number | null;
  /**
   * The ids of the turns those walk-aways happened on, so a chart can put them
   * on the bar they belong to. A turn can appear more than once if the model
   * flagged the same moment twice; the set is the reason.
   */
  bailOutTurnIds: number[];
  /** Every fumble this session captured, not just the ones still on the deck. */
  fumbles: number;
  deck: DeckOutcome;
  /** Distinct New Words the partner introduced. */
  words: Pick<Marker, "surface" | "reading" | "meaning">[];
  sprintsClosed: number;
  sprintsPlanned: number;
  /** Wall-clock length of the sitting. */
  durationMs: number;
}

/** The fewest measured turns before a first-half/second-half split is reported. */
const TREND_MIN_SAMPLES = 4;

/**
 * The smallest first-half/second-half gap worth calling a change.
 *
 * The same bar the debrief sets, and deliberately so: a learner whose halves sit
 * two seconds apart has had a normal session, and saying they "slowed down" is a
 * claim the transcript cannot back up.
 */
const TREND_MIN_DELTA_MS = 2000;

/**
 * What happened to the words fumbled in this session.
 *
 * Scoped to the session's own fumble rows, so a word the learner had already
 * fumbled last week is not credited to this sitting for a failure it already
 * knew about. A natural has left the deck when every one of this session's
 * moments of it was cleared, which is the same rule the deck view applies
 * across all sessions.
 */
function deckOutcome(fumbles: Fumble[]): DeckOutcome {
  const uncleared = new Set<string>();
  for (const fumble of fumbles) {
    if (fumble.clearedAt === null) uncleared.add(fumble.natural);
  }
  const all = new Set(fumbles.map((f) => f.natural));
  const holding = all.size === 0 ? 0 : [...all].filter((n) => uncleared.has(n)).length;
  return { fumbled: all.size, cleared: all.size - holding, holding };
}

/**
 * Build the summary from committed state.
 *
 * Takes the session only for its bounds — the turns, sprints and fumbles are the
 * evidence, and every number below is counted from them.
 */
export function buildSummary(
  session: Pick<Session, "createdAt" | "endedAt">,
  turns: Turn[],
  sprints: Sprint[],
  fumbles: Fumble[],
): SessionSummary {
  const sprintSeqById = new Map(sprints.map((s) => [s.id, s.seq]));
  const learnerTurns = turns.filter((t) => t.role === "learner");

  const pace: TurnPace[] = learnerTurns.map((turn) => ({
    id: turn.id,
    seq: turn.seq,
    sprintSeq: turn.sprintId ? (sprintSeqById.get(turn.sprintId) ?? null) : null,
    responseMs: turn.responseMs,
  }));

  const times = responseTimes(learnerTurns);
  const measured = times.length;

  let firstHalfMs: number | null = null;
  let secondHalfMs: number | null = null;
  let deltaMs: number | null = null;
  if (measured >= TREND_MIN_SAMPLES) {
    const half = Math.floor(measured / 2);
    const first = meanMs(times.slice(0, half));
    const second = meanMs(times.slice(half));
    if (first !== null && second !== null) {
      const delta = second - first;
      if (Math.abs(delta) >= TREND_MIN_DELTA_MS) {
        firstHalfMs = first;
        secondHalfMs = second;
        deltaMs = delta;
      }
    }
  }

  // A walk-away is a turn with no answer worth reading, which is what the deck
  // records as an abandoned fumble. The rate is over learner turns, so it reads
  // as "one turn in five", which is what the learner actually did.
  const bailOuts = fumbles.filter((f) => f.reason === "abandoned").length;
  const bailOutRate = learnerTurns.length === 0 ? null : bailOuts / learnerTurns.length;
  const bailOutTurnIds = fumbles
    .filter((f) => f.reason === "abandoned" && f.turnId !== null)
    .map((f) => f.turnId as number);

  const lastAt = turns.length ? turns[turns.length - 1]!.createdAt : session.createdAt;
  const endedAt = session.endedAt ?? lastAt;

  return {
    pace,
    measured,
    unmeasured: learnerTurns.length - measured,
    meanResponseMs: meanMs(times),
    slowestMs: measured ? Math.max(...times) : null,
    firstHalfMs,
    secondHalfMs,
    deltaMs,
    learnerTurns: learnerTurns.length,
    bailOuts,
    bailOutRate,
    bailOutTurnIds,
    fumbles: fumbles.length,
    deck: deckOutcome(fumbles),
    words: distinctNewWords(turns),
    sprintsClosed: sprints.filter((s) => s.status === "closed").length,
    sprintsPlanned: sprints.length,
    durationMs: Math.max(0, endedAt - session.createdAt),
  };
}

/**
 * The headline sentences, in the learner's language rather than the app's.
 *
 * The wording is a product decision made next to the numbers it describes, for
 * the same reason `debrief.ts` writes its own lines: this is the one screen where
 * a learner is most likely to believe the app, so "you got 20% faster" has to be
 * earned by four measured turns or not said at all.
 */
export function summaryLines(s: SessionSummary): string[] {
  const lines: string[] = [];

  // How long the sitting took and how much of it the learner answered for. The
  // sign-off this replaced said both, and a summary that dropped them to make
  // room for a chart would be a downgrade — "2 of 5 scenes" is how a learner sees
  // whether they got through what they set out to do.
  const scenes =
    s.sprintsPlanned > 0 ? `${s.sprintsClosed} of ${s.sprintsPlanned} scenes` : "no scenes";
  const sat = `in about ${humanDuration(s.durationMs)}`;

  if (s.learnerTurns === 0) {
    lines.push(`${scenes} ${sat}, and no turns were answered.`);
  } else if (s.meanResponseMs !== null) {
    lines.push(
      `${scenes} ${sat}: ${s.learnerTurns} ${s.learnerTurns === 1 ? "turn" : "turns"} answered, ` +
        `${humanMs(s.meanResponseMs)} on average to get a sentence out.`,
    );
  } else {
    lines.push(
      `${scenes} ${sat}: ${s.learnerTurns} ${s.learnerTurns === 1 ? "turn" : "turns"} answered, ` +
        `with no answer times recorded.`,
    );
  }

  if (s.deltaMs !== null && s.firstHalfMs !== null && s.secondHalfMs !== null) {
    // No second guard on the size of the change. `deltaMs` is null unless the
    // change already cleared `TREND_MIN_DELTA_MS`, so re-testing it here would be
    // a second copy of a threshold that lives in one named place — and a copy is
    // exactly what drifts when someone relaxes the constant.
    const seconds = Math.abs(Math.round(s.deltaMs / 1000));
    lines.push(
      (s.deltaMs < 0
        ? `You were getting quicker: ${humanMs(s.firstHalfMs)} early on, ${humanMs(s.secondHalfMs)} by the end.`
        : `You slowed down over the session: ${humanMs(s.firstHalfMs)} early on, ${humanMs(s.secondHalfMs)} by the end.`) +
        ` That is ${seconds} seconds.`,
    );
  }

  if (s.bailOuts > 0) {
    const rate = s.bailOutRate;
    const said = `You walked away from ${s.bailOuts} ${s.bailOuts === 1 ? "turn" : "turns"}`;
    // "Roughly one in five" is a description of a session. The same arithmetic on
    // a single abandoned turn says "one in one", which is a true number and a
    // useless one, so the phrasing only appears once the ratio has been seen
    // enough times over to mean something.
    const inEvery = rate === null ? 0 : Math.max(1, Math.round(1 / rate));
    lines.push(
      inEvery > 0 && s.learnerTurns >= 3 * inEvery
        ? `${said} — roughly one in ${inEvery}.`
        : `${said}.`,
    );
  } else {
    lines.push("You answered every turn — nothing was left hanging.");
  }

  if (s.deck.fumbled > 0) {
    const word = s.deck.fumbled === 1 ? "word" : "words";
    if (s.deck.holding === 0) {
      lines.push(
        s.deck.fumbled === 1
          ? "The word you fumbled came back out later in this session."
          : `All ${s.deck.fumbled} words you fumbled came back out later in this session.`,
      );
    } else if (s.deck.holding === s.deck.fumbled) {
      lines.push(
        s.deck.fumbled === 1
          ? "The one word you fumbled is still on the deck."
          : `All ${s.deck.fumbled} words you fumbled are still on the deck.`,
      );
    } else {
      lines.push(
        `${s.deck.fumbled - s.deck.holding} of the ${s.deck.fumbled} ${word} you fumbled came ` +
          `back out later; ${s.deck.holding} ${s.deck.holding === 1 ? "is" : "are"} still on the deck.`,
      );
    }
  }

  if (s.unmeasured > 0 && s.measured > 0) {
    lines.push(`${s.unmeasured} ${s.unmeasured === 1 ? "turn was" : "turns were"} not timed, and are left out of the average.`);
  }

  return lines;
}
