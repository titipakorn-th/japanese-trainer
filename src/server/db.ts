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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  scenario   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS turn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('partner', 'learner')),
  text       TEXT NOT NULL,
  natural    TEXT,
  markers    TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_session_seq ON turn (session_id, seq);
`;

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
  return db;
}

// Next's dev server re-evaluates modules on every edit; a global keeps one handle.
const globalForDb = globalThis as unknown as { __trainerDb?: Database.Database };

export const db: Database.Database = globalForDb.__trainerDb ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__trainerDb = db;
