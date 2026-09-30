import Database from "better-sqlite3";
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

/** The store always lives under ./data, whatever the file is called. */
const DATA_DIR = path.join(process.cwd(), "data");

function open(): Database.Database {
  // basename, so the setting can name a file without pointing anywhere else.
  const name = path.basename(process.env.DATABASE_FILE || "japanese-trainer.db");
  const resolved = path.join(DATA_DIR, name);
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Next's dev server re-evaluates modules on every edit; a global keeps one handle.
const globalForDb = globalThis as unknown as { __trainerDb?: Database.Database };

export const db: Database.Database = globalForDb.__trainerDb ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__trainerDb = db;
