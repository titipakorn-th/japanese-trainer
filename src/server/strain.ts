import type { Fumble, Turn } from "@/lib/types";

/**
 * Whether the conversation has shown enough strain to stop spending New Words.
 *
 * A session targets ten new words, and injecting unknown words into a live
 * conversation is the thing that makes a learner freeze. Inject too many and the
 * session stalls on word three, and the stall gets attributed to the learner's
 * own ability rather than to the injection rate. This module is the gate that
 * stops the injection, and everything downstream of it — the prompt, the marker
 * ledger, the rail, the debrief — already knows how to behave when the budget
 * stops moving. See `docs/adr/0013-strain-signals.md`.
 *
 * **Derived, never counted.** Like the word ledger, this is a pure function of
 * committed turns. There is no column saying a session went strained, because a
 * flag that can disagree with the transcript is the exact fault this project
 * keeps paying for. A reload re-derives it; a session cannot be strained by a
 * turn that was rolled back.
 *
 * **Two signals, and turn length is not one of them.** The one real session in
 * the store (`4d9c35`) shows compose time rising 24.3s → 57.6s → 67.9s across
 * three consecutive turns while turn length stayed flat at six characters. A
 * learner under strain is still producing sentences; they are reaching for them
 * more slowly. Short turns measure terseness, which at N4 is frequently the
 * correct register for an order at a counter, so a short-turn rate would have
 * scored that session as perfectly healthy.
 */

/**
 * The fewest measured compose times a session needs before its rate of change
 * means anything.
 *
 * Below this a session cannot say which half was slower, and neither can this
 * module — the split would be one number against one number. Four is not a guess:
 * it is the floor `debrief.ts` already uses before it will report a pace change
 * to the learner, and a detector willing to fire on less than the product is
 * willing to describe would disagree with the product's own account of the same
 * session. `scripts/probe-strain-data.ts` imports this, so a session the probe
 * calls usable is a session this will actually consider.
 */
export const MIN_STRAIN_SAMPLES = 4;

/**
 * PENDING CALIBRATION — issue #10 acceptance criterion 2.
 *
 * Both figures must come from observed Sessions rather than estimation, and the
 * store cannot support that yet: not one session has produced
 * `MIN_STRAIN_SAMPLES` measured compose times, and the most any single session
 * has ever produced is three. ADR 0013 records the decision and the method;
 * `npm run probe:strain-data` reports the pool to read the numbers off.
 *
 * They are typed `null` rather than filled with a plausible number on purpose.
 * `null` is the only value that makes `isStrained` return `false` for every
 * input, so an uncalibrated build behaves exactly as it does today — it keeps
 * injecting, and nothing about the conversation changes. A guessed threshold
 * would be the opposite: it would silently stop injection mid-conversation on a
 * number with no error bar, and the learner would experience that as the app
 * losing interest in them.
 */
const COMPOSE_TIME_RISE: number | null = null;
const FUMBLE_RATE_RISE: number | null = null;

/**
 * Fumbles that count as strain rather than as ordinary difficulty.
 *
 * `wrong-form` is excluded on purpose. Picking the wrong inflection of a word
 * the learner otherwise knows well is the product working — the deck exists to
 * catch that moment — and treating it as strain would stop injection on exactly
 * the turns that show the learner is engaged.
 */
const STRAIN_FUMBLE_REASONS: ReadonlySet<Fumble["reason"]> = new Set(["abandoned", "compressed"]);

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Every measured compose time in the session, oldest first. */
function composeTimes(turns: Turn[]): number[] {
  const out: number[] = [];
  for (const turn of turns) {
    if (turn.role !== "learner" || turn.responseMs === null) continue;
    out.push(turn.responseMs);
  }
  return out;
}

/**
 * The learner's composing time, later in the session against earlier in it.
 *
 * A ratio rather than a difference, because the question is "is this learner
 * slowing down" and the answer depends on how fast they normally are. A
 * difference would fire hard for a learner whose baseline is already slow and
 * not at all for a fast one creeping upward, and only the second of those is the
 * one worth stopping words for.
 *
 * Exported because the debrief reports the same movement in the same words; two
 * implementations of "did the learner slow down" would be one too many, and a
 * number the learner has already read is a number they can be asked to act on.
 */
export function composeTimeRise(turns: Turn[]): number | null {
  const times = composeTimes(turns);
  if (times.length < MIN_STRAIN_SAMPLES) return null;
  const half = Math.floor(times.length / 2);
  const first = mean(times.slice(0, half));
  const second = mean(times.slice(half));
  if (first === null || second === null || first <= 0) return null;
  return (second - first) / first;
}

/**
 * Strain fumbles in the back half against the front half, per learner turn.
 *
 * The other half of the pair the ADR chose. It is corroboration rather than a
 * second independent gate: it is derived from the same turns and the same model
 * call, so it cannot be late in the way a genuinely independent signal could.
 * Normalised per turn because a long session has more turns and more
 * opportunities, and an unnormalised count would report every full session as
 * strained.
 */
export function fumbleRateRise(turns: Turn[], fumbles: Fumble[]): number | null {
  const learnerTurns = turns.filter((t) => t.role === "learner");
  if (learnerTurns.length < MIN_STRAIN_SAMPLES) return null;

  const order = new Map<number, number>(learnerTurns.map((t, i) => [t.id, i]));
  let front = 0;
  let back = 0;
  const half = Math.floor(learnerTurns.length / 2);

  for (const fumble of fumbles) {
    if (!STRAIN_FUMBLE_REASONS.has(fumble.reason)) continue;
    const at = fumble.turnId === null ? undefined : order.get(fumble.turnId);
    // A fumble whose turn is not in this session's sequence cannot be placed in
    // a half, and guessing a side would put it in the denominator of one half
    // only. It still counts on the deck; it just does not vote here.
    if (at === undefined) continue;
    if (at < half) front += 1;
    else back += 1;
  }

  const first = front / Math.max(1, half);
  const second = back / Math.max(1, learnerTurns.length - half);
  return second - first;
}

/**
 * Whether the gate has been calibrated and can therefore fire at all.
 *
 * Separate from `isStrained` because the two answer different questions and
 * conflating them hides the dangerous one. A caller asking "is this session
 * strained?" wants a per-session answer and is correctly told no. A caller — or
 * the probe — asking "is this build deciding anything?" wants to know that the
 * answer it keeps getting is a constant, and that the constant is there because
 * nobody has calibrated it yet rather than because every session is healthy.
 */
export function strainGateArmed(): boolean {
  return COMPOSE_TIME_RISE !== null && FUMBLE_RATE_RISE !== null;
}

/**
 * Whether the planner should stop spending New Words for the rest of the session.
 *
 * True only when the session has enough measured data to support a claim, and
 * when the signals have been calibrated. The sample floor is checked before the
 * thresholds are consulted, so an uncalibrated build and an under-sampled one
 * fail for the same visible reason rather than one of them being silent.
 */
export function isStrained(turns: Turn[], fumbles: Fumble[]): boolean {
  if (COMPOSE_TIME_RISE === null || FUMBLE_RATE_RISE === null) return false;
  if (composeTimes(turns).length < MIN_STRAIN_SAMPLES) return false;

  const slower = composeTimeRise(turns);
  if (slower !== null && slower >= COMPOSE_TIME_RISE) return true;

  const fumbling = fumbleRateRise(turns, fumbles);
  return fumbling !== null && fumbling >= FUMBLE_RATE_RISE;
}
