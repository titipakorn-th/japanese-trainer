import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSummary, summaryLines } from "./summary";
import type { Fumble, Marker, Sprint, Turn } from "./types";

/**
 * The session summary is the one screen that makes a claim about the learner's
 * progress, so the tests here are mostly about what it refuses to say: a trend
 * needs enough measurements to be one, an unmeasured turn stays in the transcript
 * but out of the average, and a number is never invented where the evidence
 * ran out.
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

function sprint(partial: Partial<Sprint> & { id: string; seq: number }): Sprint {
  return {
    sessionId: "sess",
    brief: {
      slug: "counter",
      persona: "店員",
      place: "店",
      situation: "",
      goal: "",
      openingLine: "",
      correctionLine: "",
      closingLine: "",
      word: { surface: "会計", reading: "かいけい", meaning: "the bill", example: "" },
    },
    status: "closed",
    target: 6,
    startedAt: 1_000,
    endedAt: 2_000,
    endedBy: "budget",
    debrief: null,
    ...partial,
  };
}

const session = { createdAt: 0, endedAt: 60_000 };

test("pace lists every learner turn in order, with the scene it belongs to", () => {
  const turns = [
    turn({ role: "learner", seq: 0, sprintId: "s1", responseMs: 4_000 }),
    turn({ role: "partner", seq: 1, sprintId: "s1" }),
    turn({ role: "learner", seq: 2, sprintId: "s2", responseMs: 6_000 }),
  ];
  const sprints = [sprint({ id: "s1", seq: 1 }), sprint({ id: "s2", seq: 2 })];

  const s = buildSummary(session, turns, sprints, []);

  assert.equal(s.pace.length, 2, "partner turns are not learner turns");
  assert.deepEqual(
    s.pace.map((p) => [p.seq, p.sprintSeq, p.responseMs]),
    [
      [0, 1, 4_000],
      [2, 2, 6_000],
    ],
  );
});

test("a turn from before sprints existed reports a null scene rather than guessing", () => {
  const turns = [turn({ role: "learner", seq: 0, sprintId: null, responseMs: 3_000 })];

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.pace[0]?.sprintSeq, null);
});

test("unmeasured turns stay in the transcript but out of every mean", () => {
  const turns = [
    turn({ role: "learner", seq: 0, responseMs: 4_000 }),
    turn({ role: "learner", seq: 1, responseMs: null }),
  ];

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.learnerTurns, 2, "both turns happened");
  assert.equal(s.measured, 1);
  assert.equal(s.unmeasured, 1);
  assert.equal(s.meanResponseMs, 4_000, "the mean covers measured turns only");
  assert.equal(s.slowestMs, 4_000);
});

test("no measurement means no average, no slowest, and no invented zero", () => {
  const s = buildSummary(session, [turn({ role: "learner", seq: 0, responseMs: null })], [], []);

  assert.equal(s.measured, 0);
  assert.equal(s.meanResponseMs, null);
  assert.equal(s.slowestMs, null);
  assert.equal(s.meanResponseMs === 0, false);
});

test("a trend needs four measured turns, the same bar the debrief sets", () => {
  const three = [0, 1, 2].map((seq) => turn({ role: "learner", seq, responseMs: 5_000 }));
  assert.equal(buildSummary(session, three, [], []).deltaMs, null, "three is not a trend");

  const four = [0, 1, 2, 3].map((seq) =>
    turn({ role: "learner", seq, responseMs: seq < 2 ? 8_000 : 4_000 }),
  );
  const s = buildSummary(session, four, [], []);

  assert.equal(s.firstHalfMs, 8_000);
  assert.equal(s.secondHalfMs, 4_000);
  assert.equal(s.deltaMs, -4_000, "negative means the learner got quicker");
});

test("a slowing learner is reported as slowing, not as improving", () => {
  const turns = [0, 1, 2, 3].map((seq) =>
    turn({ role: "learner", seq, responseMs: seq < 2 ? 3_000 : 9_000 }),
  );

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.deltaMs, 6_000);
  assert.match(summaryLines(s).join(" "), /slowed down/i);
});

test("unmeasured turns do not get to pad the trend", () => {
  // Four learner turns, but only two were timed. A split across two samples is
  // not a trend, so the halves stay null.
  const turns = [
    turn({ role: "learner", seq: 0, responseMs: 9_000 }),
    turn({ role: "learner", seq: 1, responseMs: null }),
    turn({ role: "learner", seq: 2, responseMs: null }),
    turn({ role: "learner", seq: 3, responseMs: 3_000 }),
  ];

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.measured, 2);
  assert.equal(s.deltaMs, null);
});

test("bail-outs are counted per turn and expressed as a rate", () => {
  const turns = [0, 1, 2, 3, 4].map((seq) => turn({ role: "learner", seq, responseMs: 4_000 }));
  const fumbles = [
    fumble({ reason: "abandoned" }),
    fumble({ reason: "abandoned", natural: "伝票" }),
    fumble({ reason: "hedged" }),
  ];

  const s = buildSummary(session, turns, [], fumbles);

  assert.equal(s.bailOuts, 2, "only abandoned fumbles are walk-aways");
  assert.equal(s.bailOutRate, 0.4);
  assert.equal(s.fumbles, 3);
});

test("a walk-away can be pointed at the turn it happened on", () => {
  const first = turn({ role: "learner", seq: 0, responseMs: 4_000 });
  const second = turn({ role: "learner", seq: 1, responseMs: 4_000 });
  const fumbles = [
    fumble({ reason: "abandoned", turnId: second.id }),
    fumble({ reason: "hedged", turnId: first.id }),
  ];

  const s = buildSummary(session, [first, second], [], fumbles);

  assert.deepEqual(s.bailOutTurnIds, [second.id], "only the abandoned turn is marked");
  assert.deepEqual(
    s.pace.map((p) => p.id),
    [first.id, second.id],
    "each pace entry knows its own turn, so a chart can line them up",
  );
});

test("a walk-away with no turn behind it is still counted, just not placed", () => {
  const s = buildSummary(
    session,
    [turn({ role: "learner", seq: 0, responseMs: 4_000 })],
    [],
    [fumble({ reason: "abandoned", turnId: null })],
  );

  assert.equal(s.bailOuts, 1);
  assert.deepEqual(s.bailOutTurnIds, []);
});

test("a session with no learner turns has a bail-out rate of null, not zero", () => {
  const s = buildSummary(session, [turn({ role: "partner", seq: 0 })], [], []);

  assert.equal(s.bailOutRate, null, "one in nothing is not a rate");
});

test("a session where nothing was left hanging says so plainly", () => {
  const turns = [0, 1, 2, 3].map((seq) => turn({ role: "learner", seq, responseMs: 5_000 }));

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.bailOuts, 0);
  assert.match(summaryLines(s).join(" "), /answered every turn/i);
});

test("a lone walk-away is counted, but not dressed up as a ratio", () => {
  // One abandoned turn out of four is a real measurement, and "one in four"
  // would be a claim about a habit the session has not shown yet.
  const turns = [0, 1, 2, 3].map((seq) => turn({ role: "learner", seq, responseMs: 5_000 }));
  const s = buildSummary(session, turns, [], [fumble({ reason: "abandoned" })]);

  const line = summaryLines(s).find((l) => /walked away/i.test(l)) ?? "";

  assert.match(line, /walked away from 1 turn/i);
  assert.doesNotMatch(line, /one in/i, "one moment is not a rate");
});

test("a repeated pattern is reported as a rate", () => {
  const turns = Array.from({ length: 20 }, (_, seq) =>
    turn({ role: "learner", seq, responseMs: 5_000 }),
  );
  const fumbles = [0, 1, 2, 3].map(() => fumble({ reason: "abandoned" }));

  const s = buildSummary(session, turns, [], fumbles);

  assert.equal(s.bailOutRate, 0.2);
  assert.match(summaryLines(s).join(" "), /one in 5/i);
});

test("deck outcomes partition the words fumbled in this session", () => {
  const fumbles = [
    fumble({ reason: "hedged", natural: "会計", clearedAt: 5_000 }),
    // Same word again, still uncleared: the word has not left the deck.
    fumble({ reason: "hedged", natural: "会計" }),
    fumble({ reason: "abandoned", natural: "伝票" }),
    fumble({ reason: "wrong-form", natural: "お会計", clearedAt: 5_000 }),
  ];

  const s = buildSummary(session, [], [], fumbles);

  assert.deepEqual(s.deck, { fumbled: 3, cleared: 1, holding: 2 });
  assert.equal(s.deck.cleared + s.deck.holding, s.deck.fumbled, "no word is double-counted");
});

test("New Words are counted once however often they are marked", () => {
  const word = (surface: string): Marker => ({
    id: `m-${surface}`,
    kind: "new",
    start: 0,
    end: surface.length,
    surface,
    reading: "よみ",
    meaning: "a word",
    example: "",
  });
  const turns = [
    turn({ role: "partner", seq: 0, markers: [word("会計")] }),
    turn({ role: "learner", seq: 1, markers: [word("会計"), word("伝票")] }),
  ];

  const s = buildSummary(session, turns, [], []);

  assert.deepEqual(
    s.words.map((w) => w.surface),
    ["会計", "伝票"],
  );
});

test("the summary counts only the scenes that actually closed", () => {
  const sprints = [
    sprint({ id: "s1", seq: 1, status: "closed" }),
    sprint({ id: "s2", seq: 2, status: "closed" }),
    sprint({ id: "s3", seq: 3, status: "planned" }),
  ];

  const s = buildSummary(session, [], sprints, []);

  assert.equal(s.sprintsClosed, 2);
  assert.equal(s.sprintsPlanned, 3);
});

test("an abandoned session still gets a full account", () => {
  const turns = [turn({ role: "learner", seq: 0, responseMs: 5_000 })];
  const sprints = [sprint({ id: "s1", seq: 1, status: "closed", endedBy: "abandoned" })];

  const s = buildSummary({ createdAt: 0, endedAt: 12_000 }, turns, sprints, []);

  assert.equal(s.durationMs, 12_000);
  assert.equal(s.meanResponseMs, 5_000);
});

test("a session that is still running is measured from its last committed turn", () => {
  const turns = [turn({ role: "learner", seq: 0, responseMs: 5_000, createdAt: 9_000 })];

  const s = buildSummary({ createdAt: 0, endedAt: null }, turns, [], []);

  assert.equal(s.durationMs, 9_000);
});

test("an empty session reports honestly instead of dividing by zero", () => {
  const s = buildSummary(session, [], [], []);

  assert.equal(s.learnerTurns, 0);
  assert.equal(s.meanResponseMs, null);
  assert.equal(s.bailOutRate, null);
  assert.deepEqual(s.pace, []);
  assert.match(summaryLines(s).join(" "), /no turns/i);
});

test("the headline says how much of the session was actually done", () => {
  const sprints = [
    sprint({ id: "s1", seq: 1, status: "closed" }),
    sprint({ id: "s2", seq: 2, status: "closed" }),
    sprint({ id: "s3", seq: 3, status: "planned" }),
  ];
  const turns = Array.from({ length: 6 }, (_, seq) =>
    turn({ role: "learner", seq, sprintId: "s1", responseMs: 5_000 }),
  );

  const line = summaryLines(buildSummary(session, turns, sprints, []))[0]!;

  // The sign-off this replaced carried both, and "2 of 5" is how a learner sees
  // whether they got through what they set out to do.
  assert.match(line, /2 of 3 scenes/);
  assert.match(line, /6 turns answered/);
  assert.match(line, /1分/);
});

test("a session with no planned scenes does not claim a scene count", () => {
  const s = buildSummary({ createdAt: 0, endedAt: 5_000 }, [turn({ role: "learner", seq: 0 })], [], []);

  const line = summaryLines(s)[0]!;

  assert.match(line, /no scenes/);
  assert.doesNotMatch(line, /0 of 0/);
});

test("a claimed trend always carries its size in seconds", () => {
  // The size clause is not conditional on a second copy of the threshold: reaching
  // this branch already means the change cleared it, so a guard here would be a
  // duplicate that can drift from the constant.
  const turns = [0, 1, 2, 3].map((seq) =>
    turn({ role: "learner", seq, responseMs: seq < 2 ? 12_000 : 4_000 }),
  );

  const line = summaryLines(buildSummary(session, turns, [], [])).find((l) =>
    /getting quicker/i.test(l),
  );

  assert.ok(line, "the trend should be reported at all");
  assert.match(line, /That is 8 seconds\./);
});

test("the lines never claim a trend that the numbers do not support", () => {
  const turns = [0, 1, 2, 3].map((seq) => turn({ role: "learner", seq, responseMs: 5_000 }));

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.deltaMs, null, "a flat split is not a trend to expose either");
  assert.equal(s.firstHalfMs, null);
  assert.doesNotMatch(
    summaryLines(s).join(" "),
    /getting quicker|slowed down/i,
    "a flat session is not a trend",
  );
});

test("a gap too small to mean anything is treated as flat", () => {
  // A second apart per turn, so the halves differ by well under the threshold.
  const turns = [0, 1, 2, 3].map((seq) =>
    turn({ role: "learner", seq, responseMs: 4_000 + seq * 400 }),
  );

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.deltaMs, null);
  assert.doesNotMatch(summaryLines(s).join(" "), /getting quicker|slowed down/i);
});

/**
 * The consolidation day. Issue #10 asks for a session that stopped injecting to
 * say so plainly, and to report the words it actually met rather than a fraction
 * of ten. The tests below are mostly about the second half of that: the numbers
 * in the line have to be the transcript's numbers, and the line has to stay
 * silent on a session that was not strained — including on a build whose
 * thresholds have not been calibrated yet, which is every build until real
 * sessions exist to calibrate them from.
 */

const newWord = (surface: string): Marker => ({
  id: `m-${surface}`,
  kind: "new",
  start: 0,
  end: surface.length,
  surface,
  reading: "よみ",
  meaning: "a word",
  example: "",
});

const deckWord = (surface: string): Marker => ({
  id: `d-${surface}`,
  kind: "deck",
  start: 0,
  end: surface.length,
  surface,
  reading: "",
  meaning: "",
  example: "",
});

test("a strained session leads with the consolidation day and the words it met", () => {
  const turns = [
    turn({ role: "partner", seq: 0, markers: [newWord("会計"), newWord("伝票"), newWord("箸")] }),
    turn({ role: "partner", seq: 1, markers: [deckWord("辛口"), deckWord("冷酒"), deckWord("枝豆"), deckWord("お通し")] }),
  ];

  const lines = summaryLines(buildSummary(session, turns, [], [], true));

  assert.match(lines[0]!, /^Consolidation day — 3 new words met, 4 deck words drilled under pressure\./);
  assert.match(lines[0]!, /A word you failed and then met again is the part that sticks\./);
});

test("the consolidation day counts the words in the transcript, not a fraction of the target", () => {
  // The trap this guards is the one issue #10 names: three words against a target
  // of ten, reported as "3/10", which is true and reads as a session that failed.
  // The number the learner gets is the number that was met.
  const turns = [
    turn({ role: "partner", seq: 0, markers: [newWord("会計"), newWord("伝票")] }),
    turn({ role: "partner", seq: 1, markers: [deckWord("辛口")] }),
  ];

  const line = summaryLines(buildSummary(session, turns, [], [], true))[0]!;

  assert.match(line, /2 new words met/);
  assert.doesNotMatch(line, /\d+\s*\/\s*10/, "a fraction of the target is not what happened");
  assert.doesNotMatch(line, /10/, "the target is not a number the session was judged against");
});

test("the consolidation day does not claim deck drills that did not happen", () => {
  // A session that went strained on turn two has had no chance to put a deck word
  // back in play. Borrowing a sentence about words the learner never met again
  // would be a flattering line about work that did not happen.
  const turns = [turn({ role: "partner", seq: 0, markers: [newWord("会計")] })];

  const line = summaryLines(buildSummary(session, turns, [], [], true))[0]!;

  assert.match(line, /^Consolidation day — 1 new word met\./);
  assert.doesNotMatch(line, /drilled/, "nothing was drilled, so nothing is claimed");
  assert.match(line, /new words only/);
});

test("a session that was not strained never mentions consolidation", () => {
  const turns = [turn({ role: "partner", seq: 0, markers: [newWord("会計")] })];

  const s = buildSummary(session, turns, [], [], false);

  assert.equal(s.strained, false);
  assert.doesNotMatch(summaryLines(s).join(" "), /consolidation/i);
});

test("strained defaults to false, so an uncalibrated build says nothing", () => {
  // The gate's thresholds are null until real sessions exist to read them off, so
  // this default is what every build does today. A summary that claimed a
  // consolidation day on a build whose gate cannot fire would be a lie the
  // learner has no way to check.
  const turns = [turn({ role: "partner", seq: 0, markers: [newWord("会計")] })];

  const s = buildSummary(session, turns, [], []);

  assert.equal(s.strained, false);
  assert.doesNotMatch(summaryLines(s).join(" "), /consolidation/i);
});

test("deck words are counted once however often the partner reuses them", () => {
  const turns = [
    turn({ role: "partner", seq: 0, markers: [deckWord("辛口")] }),
    turn({ role: "partner", seq: 1, markers: [deckWord("辛口"), deckWord("冷酒")] }),
  ];

  const s = buildSummary(session, turns, [], [], true);

  assert.equal(s.deckWords, 2, "a reused deck word is still one word");
  assert.match(summaryLines(s)[0]!, /2 deck words drilled/);
});
