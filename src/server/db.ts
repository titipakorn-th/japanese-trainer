import Database, { SqliteError } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The local relational store. Single learner, no accounts, no auth.
 *
 * Client state is not the source of truth for a session; this file is. A reload
 * resumes from here, and a failed model call writes nothing at all, so a
 * network blip cannot lose the thread.
 */

/**
 * The sprint table, in one place.
 *
 * It is written here rather than inline in the schema because a store created by
 * an earlier build has to have the table rebuilt — see `rebuildSprintTable`. Two
 * copies of this statement would be two chances to get the migration wrong.
 */
function sprintTable(name: string): string {
  return `CREATE TABLE ${name} (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  sprint_slug TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  turn_target INTEGER NOT NULL,
  -- NULL for a planned sprint nobody has entered yet.
  started_at  INTEGER,
  ended_at    INTEGER,
  ended_by    TEXT,
  debrief     TEXT,
  UNIQUE (session_id, seq)
);`;
}

const SPRINT_TABLE = sprintTable("IF NOT EXISTS sprint");

const FUMBLE_TABLE = `
CREATE TABLE IF NOT EXISTS fumble (
  id            TEXT PRIMARY KEY,
  surface       TEXT NOT NULL,
  natural       TEXT NOT NULL,
  learner_said  TEXT NOT NULL,
  situation     TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('abandoned', 'compressed', 'hedged', 'wrong-form')),
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  sprint_id     TEXT REFERENCES sprint(id) ON DELETE SET NULL,
  turn_id       INTEGER REFERENCES turn(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  drilled       INTEGER NOT NULL DEFAULT 0,
  cleared_at    INTEGER
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  scenario          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  ended_at          INTEGER,
  furigana_on       INTEGER NOT NULL DEFAULT 0,
  revealed_readings TEXT NOT NULL DEFAULT '[]',
  grammar_point_slug TEXT
);

${SPRINT_TABLE}

CREATE TABLE IF NOT EXISTS turn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('partner', 'learner')),
  text           TEXT NOT NULL,
  natural        TEXT,
  markers        TEXT NOT NULL DEFAULT '[]',
  drill_natural  TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_session_seq ON turn (session_id, seq);
CREATE INDEX IF NOT EXISTS sprint_session_seq ON sprint (session_id, seq);

${FUMBLE_TABLE}
CREATE INDEX IF NOT EXISTS fumble_natural ON fumble (natural);
CREATE INDEX IF NOT EXISTS fumble_session ON fumble (session_id);
CREATE INDEX IF NOT EXISTS fumble_sprint ON fumble (sprint_id);
`;

/**
 * Columns added after the first version of the schema.
 *
 * `CREATE TABLE IF NOT EXISTS` will not touch a table that already exists, so a
 * store created by an earlier build keeps its old shape unless the columns are
 * added here. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column list is
 * read first — cheap, and only ever run at open.
 *
 * Reading first and then altering is a check-then-act, and on its own it is not
 * safe: several build workers open the same fresh store at once, and every one
 * of them can see the pre-migration shape. This is correct only because the
 * caller holds an `IMMEDIATE` write lock across it — see `open`. See
 * `docs/adr/0009-cold-start-migration.md`.
 */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["session", "ended_at", "INTEGER"],
  ["turn", "sprint_id", "TEXT"],
  ["turn", "response_ms", "INTEGER"],
  ["turn", "drill_natural", "TEXT"],
  ["fumble", "drilled", "INTEGER NOT NULL DEFAULT 0"],
  ["fumble", "cleared_at", "INTEGER"],
  ["session", "furigana_on", "INTEGER NOT NULL DEFAULT 0"],
  ["session", "revealed_readings", "TEXT NOT NULL DEFAULT '[]'"],
  ["session", "grammar_point_slug", "TEXT"],
];

/** Columns renamed in place, when the old name is present and the new one is not. */
const RENAMED_COLUMNS: [table: string, from: string, to: string][] = [
  ["sprint", "scene", "sprint_slug"],
];

function migrate(db: Database.Database): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  for (const [table, from, to] of RENAMED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === from) || columns.some((c) => c.name === to)) continue;
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }

  rebuildSprintTable(db);
  adoptPreSprintSessions(db);
}

/**
 * Rebuild the sprint table when it is the shape an earlier build wrote.
 *
 * The first version made `started_at NOT NULL`, and a session plan has to be able
 * to hold a scene nobody has entered yet, so the column became nullable. SQLite
 * cannot drop a NOT NULL constraint and `CREATE TABLE IF NOT EXISTS` will not
 * replace a table, so a store that already has the old table is rebuilt into the
 * new one with its rows copied across. Everything in it survives: the columns are
 * the same, and the old status values are a subset of the new ones.
 *
 * This is the only place a migration is allowed to be destructive, and it is
 * destructive only to a table that the current schema would refuse to write to
 * anyway.
 */
function rebuildSprintTable(db: Database.Database): void {
  const info = db.prepare("PRAGMA table_info(sprint)").all() as {
    name: string;
    notnull: number;
  }[];
  const startedAt = info.find((c) => c.name === "started_at");
  if (!startedAt || startedAt.notnull === 0) return;

  db.exec("DROP TABLE IF EXISTS sprint_migrated");
  db.exec(sprintTable("sprint_migrated"));
  db.exec(
    `INSERT INTO sprint_migrated (id, session_id, seq, sprint_slug, status, turn_target, started_at, ended_at, ended_by, debrief)
     SELECT id, session_id, seq, sprint_slug, status, turn_target, started_at, ended_at, ended_by, debrief FROM sprint`,
  );
  db.exec("DROP TABLE sprint");
  db.exec("ALTER TABLE sprint_migrated RENAME TO sprint");
  db.exec("CREATE INDEX IF NOT EXISTS sprint_session_seq ON sprint (session_id, seq)");
}

/**
 * A session from before sprints existed has turns and no sprint to hang them on.
 * Give it one closed sprint so it still reads back as a session rather than as a
 * session with a hole in it.
 */
function adoptPreSprintSessions(db: Database.Database): void {
  const orphans = db
    .prepare(
      `SELECT t.session_id AS id, MIN(t.created_at) AS started_at, MAX(t.created_at) AS ended_at,
              s.scenario AS scenario
         FROM turn t JOIN session s ON s.id = t.session_id
        WHERE t.session_id NOT IN (SELECT session_id FROM sprint)
        GROUP BY t.session_id`,
    )
    .all() as { id: string; started_at: number; ended_at: number; scenario: string }[];

  const adopt = db.prepare(
    `INSERT INTO sprint (id, session_id, seq, sprint_slug, status, turn_target, started_at, ended_at, ended_by, debrief)
     VALUES (lower(hex(randomblob(16))), ?, 1, ?, 'closed', 0, ?, ?, 'migrated', NULL)`,
  );
  const attach = db.prepare(
    `UPDATE turn SET sprint_id = ? WHERE session_id = ? AND sprint_id IS NULL`,
  );

  for (const row of orphans) {
    adopt.run(row.id, row.scenario, row.started_at, row.ended_at);
    const sprint = db
      .prepare(`SELECT id FROM sprint WHERE session_id = ? AND seq = 1`)
      .get(row.id) as { id: string } | undefined;
    if (sprint) attach.run(sprint.id, row.id);
  }
}

/**
 * How long a worker waits for the write lock that guards a migration. Stated
 * rather than inherited: waiting is half of what makes the migration safe, and
 * better-sqlite3's 5000ms default happens to be right for it.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 5000;

/**
 * Re-reads allowed while putting a *contended* store into WAL. The loop only
 * ever spins for the length of another worker's migration — milliseconds — so
 * this is a bound on a race, not a timeout; a value this large would be hiding
 * a hang.
 */
const WAL_ATTEMPTS = 200;

/** Journal mode is recorded in the file header, so a read reports what it is now. */
const isWal = (db: Database.Database): boolean => db.pragma("journal_mode", { simple: true }) === "wal";

/**
 * Put the store in WAL, and survive the build workers that are not first.
 *
 * This is the one statement in the file that a busy timeout cannot rescue:
 * changing journal mode needs an exclusive lock, and SQLite returns `SQLITE_BUSY`
 * for it without consulting the busy handler — measured at 0ms against a held
 * write lock, and succeeding 1ms after that lock was released. A worker that
 * reaches it while a sibling is migrating dies before `migrate` is ever called.
 *
 * What does work is re-reading. WAL is set *before* the write lock is taken, so
 * a worker that trips over `SQLITE_BUSY` here is almost always looking at a
 * store another worker already put into WAL. That reasoning depends on the
 * ordering in `open`, and stops holding if the two are swapped.
 */
function enableWal(db: Database.Database): void {
  for (let attempt = 1; !isWal(db); attempt++) {
    try {
      db.pragma("journal_mode = WAL");
    } catch (error) {
      // Contention is worth another look; permissions or corruption is not.
      if (!(error instanceof SqliteError) || error.code !== "SQLITE_BUSY" || attempt >= WAL_ATTEMPTS) throw error;
    }
  }
}

/** The store always lives under ./data, whatever the file is called. */
const DATA_DIR = path.join(process.cwd(), "data");

function open(): Database.Database {
  // basename, so the setting can name a file without pointing anywhere else.
  const name = path.basename(process.env.DATABASE_FILE || "japanese-trainer.db");
  const resolved = path.join(DATA_DIR, name);
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(resolved);
  // Before anything that can contend, and explicit rather than inherited.
  db.pragma(`busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  enableWal(db);
  db.pragma("foreign_keys = ON");

  /**
   * The schema and the migration are one transaction, taken as a write lock up
   * front — `next build` collects page data with a pool of workers and every one
   * of them imports this module, so a first build in a fresh clone is a dozen
   * processes migrating one new file at once.
   *
   * `immediate` locks at `BEGIN`, before the first `PRAGMA`, so the column
   * re-reads see the winner's committed state. A deferred transaction would not
   * lock until its first write, which is the check-then-act this removes.
   */
  db.transaction(() => {
    db.exec(SCHEMA);
    migrate(db);
  }).immediate();

  return db;
}

// Next's dev server re-evaluates modules on every edit; a global keeps one handle.
const globalForDb = globalThis as unknown as { __trainerDb?: Database.Database };

export const db: Database.Database = globalForDb.__trainerDb ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__trainerDb = db;
