import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Race N cold starts against one fresh store, and report the shape they leave.
 *
 * `next build` collects page data with a pool of workers, and every one of them
 * imports `src/server/db.ts`, which opens the store and migrates it at module
 * scope. On a build where `data/` does not exist yet, that is a dozen processes
 * creating and migrating the same file at the same moment — the first build a
 * new contributor ever runs.
 *
 * The failure this exists to catch is quiet in the worst way: it is a schema
 * error, so it reads as "the schema is wrong" rather than "two processes both
 * decided to add the same column", and the one line that would say otherwise is
 * a `duplicate column name` from whichever worker lost. Nothing else about the
 * build looks different, so the signal has to come from here.
 *
 * The workers are released against a shared wall-clock instant rather than just
 * spawned together, because process startup jitter is wider than the race window
 * itself — spawn them in a loop and they arrive already serialised, and a probe
 * that can only pass is not a probe.
 */

const WORKERS = Number(process.env.PROBE_WORKERS ?? 10);
const TRIALS = Number(process.env.PROBE_TRIALS ?? 5);
const SELF = process.argv[1]!;

/**
 * A busy lock and a duplicate column are different bugs with different fixes, so
 * they are counted separately: the first means the write lock is not being
 * waited on, the second means the check-and-act is not atomic. Merging them into
 * one "it failed" would hide which one came back.
 */

if (process.argv[2] === "--worker") {
  // The parent owns the file name and the release instant; this process only
  // has to arrive at the migration at the same time as its siblings.
  await new Promise<void>((resolve) => {
    const remaining = Number(process.env.PROBE_START_AT!) - Date.now();
    if (remaining > 0) setTimeout(resolve, remaining);
    else resolve();
  });
  await import("@/server/db");
  process.exit(0);
}

/** One child, and whatever it died of. */
function runWorker(name: string, startAt: number): Promise<{ code: number; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", SELF, "--worker"], {
      env: { ...process.env, DATABASE_FILE: name, PROBE_START_AT: String(startAt) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.stdout.resume();
    child.on("close", (code) => {
      // `duplicate column name` is the whole point; anything else is context so
      // a failure can be told apart from a timeout.
      const message = /SqliteError: (.*)/.exec(error)?.[1] ?? error;
      const lastLine = message.trim().split("\n").pop() ?? message;
      resolve({ code: code ?? -1, error: lastLine });
    });
  });
}

/**
 * What a correct cold start has to leave behind.
 *
 * Read from the file after the last worker exits, so this is a statement about
 * the store a build actually produced and not about any one worker's opinion.
 */
const EXPECTED_COLUMNS: [table: string, column: string][] = [
  ["session", "ended_at"],
  ["session", "furigana_on"],
  ["session", "revealed_readings"],
  ["session", "grammar_point_slug"],
  ["turn", "sprint_id"],
  ["turn", "response_ms"],
  ["turn", "drill_natural"],
  ["fumble", "drilled"],
  ["fumble", "cleared_at"],
];

console.log(`workers: ${WORKERS} per trial, ${TRIALS} trials, one fresh store per trial`);
console.log();

let failed = 0;
let duplicateColumn = 0;
let missing = 0;

for (let trial = 1; trial <= TRIALS; trial++) {
  // A bare name, not a path: `open()` takes the basename of DATABASE_FILE and
  // puts the store under ./data. Pointing it at a temp directory would be
  // silently ignored, and every trial would then read the trial-one store —
  // which is already migrated, so nothing would ever race.
  const name = `migrate-probe-${process.pid}-${trial}.db`;
  const file = path.join(process.cwd(), "data", name);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });

  // Long enough to cover tsx startup on a cold module graph, short enough that
  // the workers are still inside the migration when they are released.
  const startAt = Date.now() + 1500;
  const t0 = performance.now();

  const results = await Promise.all(Array.from({ length: WORKERS }, () => runWorker(name, startAt)));
  const elapsed = performance.now() - t0;

  const dead = results.filter((r) => r.code !== 0);
  const dupes = dead.filter((r) => /duplicate column name/.test(r.error));
  const locked = dead.filter((r) => /database is locked|busy/i.test(r.error));
  failed += dead.length;
  duplicateColumn += dupes.length;
  console.log(
    `  trial ${String(trial).padStart(2)}  ${WORKERS - dead.length}/${WORKERS} survived  ` +
      `${elapsed.toFixed(0)}ms  ${dead.length ? `DEAD ${dead.length}` : "clean"}` +
      (dupes.length ? `  duplicate column x${dupes.length}` : "") +
      (locked.length ? `  lock timeout x${locked.length}` : ""),
  );
  for (const d of dead.slice(0, 3)) console.log(`            ${d.code}  ${d.error}`);

  // A build that fails to migrate is bad, but a build that *claims* to migrate
  // and quietly leaves a column out is worse: every later read fails instead.
  // Read-write, not readonly: the store is in WAL, and a readonly handle cannot
  // attach to a WAL database that has no live -shm beside it.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(file);
  const gaps: string[] = [];
  for (const [table, column] of EXPECTED_COLUMNS) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!info.some((c) => c.name === column)) gaps.push(`${table}.${column}`);
  }
  const sprint = db.prepare("PRAGMA table_info(sprint)").all() as { name: string; notnull: number }[];
  const startedAt = sprint.find((c) => c.name === "started_at");
  if (!sprint.some((c) => c.name === "sprint_slug")) gaps.push("sprint.sprint_slug");
  if (sprint.some((c) => c.name === "scene")) gaps.push("sprint.scene (rename did not run)");
  // A NOT NULL `started_at` is the shape the rebuild exists to retire; if it is
  // still there, a planned sprint nobody has entered cannot be written.
  if (startedAt && startedAt.notnull === 1) gaps.push("sprint.started_at still NOT NULL");
  db.close();
  missing += gaps.length;
  if (gaps.length) console.log(`            MISSING  ${gaps.join(", ")}`);

  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}

console.log();
console.log(`workers: ${WORKERS * TRIALS} cold starts, ${failed} died`);

if (failed || missing) {
  if (duplicateColumn) {
    console.log(
      `\n${duplicateColumn} worker(s) died on \`duplicate column name\`. That is the cold-build` +
        `\nfailure: migrate() checked the column list outside the lock that guards the ALTER, so` +
        `\ntwo workers both decided the column was missing. See the note in src/server/db.ts.`,
    );
  }
  if (missing) console.log(`${missing} schema gap(s) — a store that opened but did not migrate.`);
  process.exitCode = 1;
} else {
  console.log(`schema:  all ${EXPECTED_COLUMNS.length} added columns present, sprint table current`);
  console.log(`result:  every cold start survived ${WORKERS}-way contention`);
}
