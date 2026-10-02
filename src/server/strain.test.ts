import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  composeTimeRise,
  fumbleRateRise,
  isStrained,
  MIN_STRAIN_SAMPLES,
  strainGateArmed,
} from "./strain";
import type { Fumble, Turn } from "@/lib/types";

/**
 * The strain gate.
 *
 * Two properties matter more than the arithmetic here, and both are about what
 * this refuses to do.
 *
 * The first is that it is inert. Issue #10 requires its thresholds to come from
 * observed sessions rather than estimation, and the store cannot support that
 * yet, so the constants are `null` and every session is unstrained. That is
 * deliberate: a guessed threshold would stop injection mid-conversation on a
 * number with no error bar, and the learner would experience that as the app
 * losing interest in them. The test that pins this is the one that matters most,
 * because the failure it prevents is invisible — a build that quietly stopped
 * spending New Words would look like a build that had run out of words.
 *
 * The second is that turn length is not a signal. In the one real session on
 * this machine, compose time rose 24.3s → 57.6s → 67.9s while turn length stayed
 * flat at six characters. A short-turn rate would have scored it as healthy.
 */

let nextId = 1;

function turn(partial: Partial<Turn> & { role: Turn["role"] }): Turn {
  return {
    id: nextId++,
    seq: nextId,
    sprintId: "s1",
    text: "…",
    naturalPhrasing: null,
    markers: [],
    kind: "normal",
    drillNatural: null,
    responseMs: null,
    createdAt: 1_000,
    ...partial,
  };
}

function fumble(partial: Partial<Fumble> & { reason: Fumble["reason"] }): Fumble {
  return {
    id: `f${nextId++}`,
    surface: "",
    natural: "会計",
    learnerSaid: "",
    situation: "",
    sessionId: "sess",
    sprintId: "s1",
    turnId: null,
    createdAt: 2_000,
    drilled: false,
    clearedAt: null,
    ...partial,
  };
}

/** `count` learner turns taking `ms` each, oldest first. */
const learnerTurns = (times: number[]): Turn[] =>
  times.map((ms, i) => turn({ role: "learner", seq: i, responseMs: ms }));

test("the gate is inert on every session while the thresholds are null", () => {
  // The 4d9c35 shape: a tripling of compose time, which is the clearest strain
  // signal in the store. It must still not fire, because no threshold exists.
  const rising = learnerTurns([24_300, 24_400, 57_600, 57_700, 67_900, 68_000]);

  assert.equal(isStrained(rising, []), false, "an uncalibrated gate must not fire on real data");
  assert.equal(isStrained(rising, [fumble({ reason: "abandoned", turnId: 6 })]), false);
  assert.equal(isStrained(learnerTurns([1, 1, 1, 60_000, 60_000, 90_000]), []), false);
});

test("compose time rise is null below the sample floor rather than a guess", () => {
  const tooFew = learnerTurns([10_000, 40_000, 40_000]);

  assert.equal(tooFew.length, MIN_STRAIN_SAMPLES - 1);
  assert.equal(composeTimeRise(tooFew), null, "three samples cannot be split into halves");
});

test("compose time rise is null for a session with no timings at all", () => {
  assert.equal(composeTimeRise([turn({ role: "learner" }), turn({ role: "learner" })]), null);
  assert.equal(composeTimeRise([]), null);
});

test("compose time rise measures the learner slowing down, not turn length", () => {
  // Six flat-length turns, rising time. The signal moves; the length does not.
  const turns = learnerTurns([20_000, 20_000, 20_000, 60_000, 60_000, 60_000]);
  for (const t of turns) t.text = "六文字";

  const rise = composeTimeRise(turns);

  assert.equal(rise, 2, "60s against 20s is a tripling of the first half's mean");
  assert.equal(
    new Set(turns.map((t) => t.text.length)).size,
    1,
    "every turn is the same length, so length carries no signal here",
  );
});

test("a session that speeds up reports a negative rise", () => {
  const rise = composeTimeRise(learnerTurns([60_000, 60_000, 60_000, 20_000, 20_000, 20_000]));

  assert.equal(rise, -(2 / 3), "20s against 60s is a fall of two thirds");
});

test("fumble rate rise needs the same floor, and is a difference not a ratio", () => {
  const turns = learnerTurns([10_000, 10_000, 10_000, 10_000]);
  // None in the front half, two in the back: 0/2 against 2/2.
  const back = [
    fumble({ reason: "compressed", turnId: turns[2]!.id }),
    fumble({ reason: "abandoned", turnId: turns[3]!.id }),
  ];

  assert.equal(fumbleRateRise(turns, back), 1);
  assert.equal(fumbleRateRise(learnerTurns([1, 1]), back), null, "two turns is not a split");
});

test("a wrong-form fumble does not count as strain", () => {
  // Picking the wrong inflection is the deck working, not a learner going quiet.
  // Counting it would stop injection on exactly the turns that show engagement.
  const turns = learnerTurns([10_000, 10_000, 10_000, 10_000]);
  const wrongForms = [
    fumble({ reason: "wrong-form", turnId: turns[2]!.id }),
    fumble({ reason: "wrong-form", turnId: turns[3]!.id }),
  ];

  assert.equal(fumbleRateRise(turns, wrongForms), 0);
});

test("a fumble with no place in the session does not vote", () => {
  // `turnId: null` is a real shape — a fumble the model caught without a turn to
  // attach to. Placing it in a half would put it in one half's numerator and
  // neither half's denominator.
  const turns = learnerTurns([10_000, 10_000, 10_000, 10_000]);

  assert.equal(fumbleRateRise(turns, [fumble({ reason: "abandoned", turnId: null })]), 0);
  assert.equal(fumbleRateRise(turns, [fumble({ reason: "abandoned", turnId: 9_999 })]), 0);
});

test("a flat session is not a rise", () => {
  assert.equal(composeTimeRise(learnerTurns([30_000, 30_000, 30_000, 30_000])), 0);
});

test("the gate reports itself unarmed while the thresholds are null", () => {
  // Kept separate from `isStrained` on purpose. Asking "is this session
  // strained?" correctly answers no forever on this build; asking "is this build
  // deciding anything?" has to be able to say no for a different reason, or the
  // constant answer reads as a healthy transcript rather than a missing number.
  assert.equal(strainGateArmed(), false);
  assert.equal(isStrained(learnerTurns([1, 9, 9, 9, 9, 9]), []), false);
});
