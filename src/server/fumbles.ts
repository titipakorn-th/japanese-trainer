import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { Fumble, FumbleDeckEntry, FumbleReason } from "@/lib/types";

/**
 * The Fumble Deck, in two layers.
 *
 * A Fumble is a moment — one row per detection. The deck the rail shows is the
 * aggregation by `natural`, ordered by how often each word has been fumbled and
 * when it was last seen, so the worst offenders sit at the top.
 *
 * Fumble capture is the load-bearing piece of the project. There are no automated
 * tests for detection, so anything that mutates the prompt has to be checked by
 * driving the app and reading the deck count off the coach rail: a card that reads
 * "Fumble Deck — 0" mid-session is a silent regression even when the conversation
 * itself looks fine.
 */

const REASONS: ReadonlySet<string> = new Set<FumbleReason>([
  "abandoned",
  "compressed",
  "hedged",
  "wrong-form",
]);

interface FumbleRow {
  id: string;
  surface: string;
  natural: string;
  learner_said: string;
  situation: string;
  reason: string;
  session_id: string;
  sprint_id: string | null;
  turn_id: number | null;
  created_at: number;
}

function toFumble(row: FumbleRow): Fumble {
  return {
    id: row.id,
    surface: row.surface,
    natural: row.natural,
    learnerSaid: row.learner_said,
    situation: row.situation,
    reason: REASONS.has(row.reason) ? (row.reason as FumbleReason) : "hedged",
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    turnId: row.turn_id,
    createdAt: row.created_at,
  };
}

export interface DetectedFumble {
  surface: string;
  natural: string;
  reason: FumbleReason;
}

/**
 * Persist a batch of fumbles from one model call.
 *
 * Called inside the same transaction as the learner turn and the partner reply, so
 * a failed or aborted call writes no fumble rows. `sprintId` and `turnId` are filled
 * in by the turn machinery — they are the row the call is being attached to.
 */
export const insertFumbles = (
  sessionId: string,
  sprintId: string | null,
  turnId: number | null,
  learnerSaid: string,
  situation: string,
  detected: DetectedFumble[],
): Fumble[] => {
  const now = Date.now();
  const rows: Fumble[] = [];
  for (const f of detected) {
    if (!REASONS.has(f.reason)) continue;
    if (typeof f.natural !== "string" || !f.natural.trim()) continue;
    rows.push({
      id: randomUUID(),
      surface: typeof f.surface === "string" ? f.surface : "",
      natural: f.natural.trim(),
      learnerSaid,
      situation,
      reason: f.reason,
      sessionId,
      sprintId,
      turnId,
      createdAt: now,
    });
  }
  if (rows.length === 0) return [];

  const insert = db.prepare(
    `INSERT INTO fumble (id, surface, natural, learner_said, situation, reason, session_id, sprint_id, turn_id, created_at)
     VALUES (@id, @surface, @natural, @learnerSaid, @situation, @reason, @sessionId, @sprintId, @turnId, @createdAt)`,
  );
  for (const row of rows) {
    insert.run(row);
  }
  return rows;
}

/**
 * The deck the rail shows, ordered worst offenders first.
 *
 * A learner who fumbled the same natural form three times across three turns sees
 * one entry, not three: the count is the aggregation, the entries are the words.
 * Ties on count break on recency, so a fumble that happened this session edges out
 * one from a session ago.
 */
export function getFumbleDeck(): FumbleDeckEntry[] {
  const rows = db
    .prepare(
      `SELECT natural, COUNT(*) AS count, MAX(created_at) AS last_seen_at
         FROM fumble
        GROUP BY natural
        ORDER BY count DESC, last_seen_at DESC`,
    )
    .all() as { natural: string; count: number; last_seen_at: number }[];
  return rows.map((r) => ({
    natural: r.natural,
    count: r.count,
    lastSeenAt: r.last_seen_at,
  }));
}

/** Distinct natural forms on the deck. Equivalent to `getFumbleDeck().length`, kept as a helper for callers that only need the count. */
export function getFumbleDeckSize(): number {
  return getFumbleDeck().length;
}

/**
 * Every fumble a sprint caught, in order.
 *
 * The debrief lists moments, not aggregated words: the learner wants to see the
 * specific failures, with the situation that produced each one, and the card has
 * room for that.
 */
export function getSprintFumbles(sprintId: string): Fumble[] {
  const rows = db
    .prepare(
      `SELECT * FROM fumble WHERE sprint_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(sprintId) as FumbleRow[];
  return rows.map(toFumble);
}
