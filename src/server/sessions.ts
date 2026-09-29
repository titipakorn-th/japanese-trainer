import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { Marker, Scenario, Session, SessionState, Turn } from "@/lib/types";

/** The one scene this slice runs. Sprints and scenario selection come later. */
export const IZAKAYA: Scenario = {
  slug: "izakaya",
  title: "居酒屋「灯」",
  place: "東京の小さな居酒屋「灯」",
  goal: "飲み物と肴を注文して、会計まで通す",
};

const SCENARIOS: Record<string, Scenario> = { [IZAKAYA.slug]: IZAKAYA };

interface SessionRow {
  id: string;
  created_at: number;
  scenario: string;
  status: string;
}

interface TurnRow {
  id: number;
  seq: number;
  role: string;
  text: string;
  natural: string | null;
  markers: string;
  created_at: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    scenario: SCENARIOS[row.scenario] ?? IZAKAYA,
    status: row.status === "ended" ? "ended" : "active",
  };
}

function toTurn(row: TurnRow): Turn {
  let markers: Marker[] = [];
  try {
    markers = JSON.parse(row.markers) as Marker[];
  } catch {
    markers = [];
  }
  return {
    id: row.id,
    seq: row.seq,
    role: row.role === "learner" ? "learner" : "partner",
    text: row.text,
    naturalPhrasing: row.natural,
    markers,
    createdAt: row.created_at,
  };
}

export function createSession(scenario: Scenario = IZAKAYA): Session {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO session (id, created_at, scenario, status) VALUES (?, ?, ?, 'active')").run(
    id,
    now,
    scenario.slug,
  );
  return { id, createdAt: now, scenario, status: "active" };
}

export function getSession(id: string): Session | null {
  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function getTurns(sessionId: string): Turn[] {
  const rows = db
    .prepare("SELECT * FROM turn WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as TurnRow[];
  return rows.map(toTurn);
}

export function getSessionState(id: string): SessionState | null {
  const session = getSession(id);
  if (!session) return null;
  return { session, turns: getTurns(id) };
}

export function nextSeq(sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), -1) AS max FROM turn WHERE session_id = ?")
    .get(sessionId) as { max: number };
  return row.max + 1;
}

export interface NewTurn {
  role: Turn["role"];
  text: string;
  naturalPhrasing: string | null;
  markers: Marker[];
}

const insertTurn = db.prepare(
  `INSERT INTO turn (session_id, seq, role, text, natural, markers, created_at)
   VALUES (@sessionId, @seq, @role, @text, @natural, @markers, @createdAt)`,
);

function writeTurn(sessionId: string, seq: number, t: NewTurn, createdAt: number): Turn {
  const info = insertTurn.run({
    sessionId,
    seq,
    role: t.role,
    text: t.text,
    natural: t.naturalPhrasing,
    markers: JSON.stringify(t.markers),
    createdAt,
  });
  return {
    id: Number(info.lastInsertRowid),
    seq,
    role: t.role,
    text: t.text,
    naturalPhrasing: t.naturalPhrasing,
    markers: t.markers,
    createdAt,
  };
}

/**
 * Commit a whole exchange, or nothing.
 *
 * A learner's turn and the partner's reply land in one transaction. The stream
 * only calls this after the model has finished cleanly, so a failed or timed-out
 * call cannot advance the conversation by half a turn.
 *
 * The quiet correction is stored on the *learner's* turn, not the partner's. It
 * is a rephrasing of what the learner said, and it belongs under what they said.
 */
export const commitExchange = db.transaction(
  (
    sessionId: string,
    learner: (NewTurn & { naturalPhrasing: string | null }) | null,
    partner: NewTurn,
  ): { learnerTurn: Turn | null; partnerTurn: Turn } => {
    const now = Date.now();
    const seq = nextSeq(sessionId);
    const learnerTurn = learner ? writeTurn(sessionId, seq, learner, now) : null;
    const partnerTurn = writeTurn(sessionId, seq + (learner ? 1 : 0), partner, now);
    return { learnerTurn, partnerTurn };
  },
);
