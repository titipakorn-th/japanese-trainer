import path from "node:path";

/**
 * Report whether the real Sessions on this machine can carry a strain threshold.
 *
 * This reads the learner's own store and changes nothing. It exists because the
 * decision in `docs/adr/0007-strain-signals.md` has to set its numbers from
 * observed Sessions rather than from estimation, and the cost of getting that
 * wrong is paid in the learner's time: a Session practised for half an hour and
 * then discarded as unmeasurable is half an hour gone, and it is not obvious
 * afterwards which ones those were.
 *
 * The measurement itself is sound. `useTurn` starts the clock when a `done`
 * event lands and stops it at submit, so `response_ms` is the time from the
 * partner's line becoming readable to the learner's turn being sent — the
 * composing time, with none of the model's latency in it. Two things make it
 * sparser than it looks, and both are structural rather than broken:
 *
 *   - The first learner turn of a Session is never measured. There is no prior
 *     partner line in the page to measure from, and `readyAt` is null until the
 *     opening commits. Guessing a time for it would put a fabricated number
 *     into the signal the threshold is derived from.
 *   - A reload clears `readyAt`, so the first turn after one is unmeasured too.
 *     Re-reading a transcript is not hesitation and must not be counted as it.
 *
 * So a Session's usable sample count is its learner turns minus roughly one,
 * and the smallest number worth splitting in half is four — the same floor
 * `debrief.ts` uses before it will report a pace change at all. Below that a
 * Session cannot say which half was slower, and neither can this probe.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const name = path.basename(process.env.DATABASE_FILE || "japanese-trainer.db");

/** The floor `debrief.ts` uses before reporting a pace delta, reused deliberately. */

const { default: Database } = await import("better-sqlite3");
const db = new Database(path.join(DATA_DIR, name), { readonly: true });

// The floor the detector itself uses, imported rather than restated. A probe that
// called a Session usable while `isStrained` would refuse to consider it is worse
// than no probe: it would report an all-clear and the numbers would still not
// move.
const { MIN_STRAIN_SAMPLES: MIN_SAMPLES, strainGateArmed } = await import("@/server/strain");

/**
 * A gap longer than this means the tab was away, not that the learner hesitated.
 *
 * The same ten minutes the server uses to discard an implausible `response_ms`,
 * and deliberately so: a turn the browser cannot honestly time becomes a null in
 * the store, and this is that null's cause made visible rather than a second
 * place that decides where the line sits.
 */
const IDLE_GAP_MS = 10 * 60_000;

interface Sample {
  sessionId: string;
  seq: number;
  ms: number;
}

const sessions = db
  .prepare(
    `SELECT id, scenario, created_at, status FROM session
     WHERE EXISTS (SELECT 1 FROM turn t WHERE t.session_id = session.id AND t.role = 'learner')
     ORDER BY created_at`,
  )
  .all() as { id: string; scenario: string; created_at: number; status: string }[];

const turnRows = db
  .prepare(
    `SELECT session_id, seq, response_ms, created_at FROM turn
     WHERE role = 'learner' ORDER BY session_id, seq`,
  )
  .all() as { session_id: string; seq: number; response_ms: number | null; created_at: number }[];

/**
 * Every turn in the session, both roles, for the idle-gap check.
 *
 * Learner turns alone would miss the case that matters most. A Session opened
 * and then left has exactly one learner turn, so the gap between learner turns
 * is undefined — but the 107 minutes between the partner's opening and the
 * learner's eventual reply is the whole story, and it is only visible if the
 * opening is in the sequence.
 */
const allTurnRows = db
  .prepare(`SELECT session_id, created_at FROM turn ORDER BY session_id, seq`)
  .all() as { session_id: string; created_at: number }[];

const fumbleRows = db
  .prepare(`SELECT session_id, reason FROM fumble`)
  .all() as { session_id: string; reason: string }[];

const bySession = new Map<string, Sample[]>();
for (const row of turnRows) {
  if (row.response_ms === null) continue;
  const list = bySession.get(row.session_id) ?? [];
  list.push({ sessionId: row.session_id, seq: row.seq, ms: row.response_ms });
  bySession.set(row.session_id, list);
}

const fumblesBySession = new Map<string, number>();
for (const row of fumbleRows) {
  fumblesBySession.set(row.session_id, (fumblesBySession.get(row.session_id) ?? 0) + 1);
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

const short = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;

console.log(`store: data/${name}\n`);

let usableCount = 0;
let idleCount = 0;
const allUsable: number[] = [];

for (const session of sessions) {
  const samples = bySession.get(session.id) ?? [];
  const shortId = session.id.slice(0, 6);
  const fumbles = fumblesBySession.get(session.id) ?? 0;
  const usable = samples.length >= MIN_SAMPLES;

  // The gap between consecutive learner turns, which is the difference between a
  // Session practised and a Session opened and left.
  //
  // `cd8bd5` is the case this exists for: opened at 23:44, one turn typed at
  // 01:31, 107 minutes later. It shows up in the store as a Session with a
  // learner turn and a real 6.0s compose time, and "too few samples" is a true
  // but useless thing to be told about it — the samples are not too few, the
  // Session is not practice. Without the gap the probe cannot say which of the
  // two it is, and a learner told only "too few" has no idea what to do differently.
  //
  // The threshold is the same ten minutes the server uses to discard an
  // implausible timing, deliberately: a turn the browser could not measure
  // because the tab was away for an hour is a null, and this is that null's
  // visible cause rather than a second place that decides where the line is.
  const at = allTurnRows
    .filter((r) => r.session_id === session.id)
    .map((r) => r.created_at)
    .sort((a, b) => a - b);
  let largestGapMs = 0;
  for (let i = 1; i < at.length; i += 1) {
    largestGapMs = Math.max(largestGapMs, at[i]! - at[i - 1]!);
  }
  const idle = largestGapMs > IDLE_GAP_MS;
  if (idle) idleCount += 1;
  // An idle Session never counts towards the pool, however many timings it
  // happens to contain. Its samples are real measurements of a learner who was
  // there — but they are not samples of a conversation, and letting them into
  // the pool would be the one way this probe could lie convincingly.
  if (usable && !idle) {
    usableCount += 1;
    allUsable.push(...samples.map((s) => s.ms));
  }

  if (samples.length === 0) {
    console.log(
      `  --      ${shortId}  ${session.scenario}  ${session.status}  ` +
        `no measured compose times — 1st turn of a session is never measured` +
        (idle ? `  (idle: sat ${short(largestGapMs)} between turns)` : ""),
    );
    continue;
  }

  const half = Math.floor(samples.length / 2);
  const first = mean(samples.slice(0, half).map((s) => s.ms));
  const second = mean(samples.slice(half).map((s) => s.ms));
  const delta =
    first !== null && second !== null && first > 0 ? ((second - first) / first) * 100 : null;

  const trend = idle
    ? `IDLE — sat ${short(largestGapMs)} between turns, so this is not practice`
    : !usable
      ? `too few to split (need ${MIN_SAMPLES})`
      : delta === null
        ? "no trend"
        : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% first half -> second half`;

  console.log(
    `  ${usable ? "ok  " : idle ? "idle" : "thin"}  ${shortId}  ${session.scenario}  ${session.status}  ` +
      `${samples.length} measured  ${trend}  ` +
      `times: ${samples.map((s) => short(s.ms)).join(" ")}  fumbles: ${fumbles}`,
  );
}

const sorted = [...allUsable].sort((a, b) => a - b);
const pct = (p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const max = sorted[sorted.length - 1] ?? 0;

console.log(
  `\n${usableCount} of ${sessions.length} Sessions can carry a threshold ` +
    `(${MIN_SAMPLES}+ measured compose times each).` +
    (idleCount > 0
      ? ` ${idleCount} excluded as idle — opened and left, not practised.`
      : ""),
);

if (sorted.length > 0) {
  console.log(
    `pool of ${sorted.length} usable compose times: ` +
      `p10 ${short(pct(10))}, p25 ${short(pct(25))}, median ${short(pct(50))}, ` +
      `p75 ${short(pct(75))}, p90 ${short(pct(90))}, max ${short(max)}`,
  );
  const abandoned = fumbleRows.filter((f) => f.reason === "abandoned").length;
  console.log(
    `fumbles: ${fumbleRows.length} total, ${abandoned} abandoned ` +
      `(${((abandoned / Math.max(1, fumbleRows.length)) * 100).toFixed(0)}%).`,
  );
}

if (usableCount === 0) {
  console.log(
    "\nNo Session has enough measured compose times to split into halves. A\n" +
      "threshold set now would be estimation, which is what the ADR forbids." +
      (idleCount > 0
        ? "\n\nThe rows marked idle are not a near miss — the tab was away for hours,\n" +
          "so those Sessions are burnt whatever you do with them now. A Session has\n" +
          "to be started and finished in one sitting: 3 closed scenes clears the floor\n" +
          "of 4 measured turns."
        : "\n\nPractise Sessions to the end — 3 closed scenes clears the floor of 4\n" +
          "measured turns — then run this again."),
  );
}

// The two halves of the slice are separate and can each be wrong on their own, so
// they are reported separately. A build with thresholds filled in and no data to
// justify them is armed and deaf; a build with plenty of data and no thresholds is
// deaf and safe. Only the second is where this project wants to be right now.
const armed = strainGateArmed();
console.log(
  armed
    ? `gate: armed — thresholds are set, and ${usableCount} Session(s) can be read against them.`
    : "gate: inert — thresholds are null, so the planner keeps injecting whatever " +
      "happens and isStrained answers false for every input.",
);
if (armed && usableCount === 0) {
  console.log(
    "  those thresholds have no observed sessions behind them, which is the state\n" +
      "  issue #10's acceptance criteria forbid. Un-set them until there is data.",
  );
}
