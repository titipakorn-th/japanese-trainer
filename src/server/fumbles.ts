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
 * A word leaves the deck when the learner produces it unprompted in a later
 * conversation. The row is kept and stamped with `cleared_at` — the moment is
 * still on the deck's history, but the deck view filters on `cleared_at IS NULL`,
 * so the rail shrinks visibly as the learner improves. Shrinkage is the clearest
 * single signal of progress, so this is a first-class behaviour rather than a
 * cleanup job.
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
  drilled: number | null;
  cleared_at: number | null;
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
    drilled: row.drilled === 1,
    clearedAt: row.cleared_at,
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
      drilled: false,
      clearedAt: null,
    });
  }
  if (rows.length === 0) return [];

  const insert = db.prepare(
    `INSERT INTO fumble (id, surface, natural, learner_said, situation, reason, session_id, sprint_id, turn_id, created_at, drilled, cleared_at)
     VALUES (@id, @surface, @natural, @learnerSaid, @situation, @reason, @sessionId, @sprintId, @turnId, @createdAt, 0, NULL)`,
  );
  for (const row of rows) {
    insert.run(row);
  }
  return rows;
}

/**
 * Mark every uncleared moment of one natural form as produced.
 *
 * Called from inside the turn transaction when the model reports the learner said
 * the deck word unprompted. A fumble that was already cleared is left alone: the
 * timestamp of the first success is the one the deck history records, so a later
 * re-production does not overwrite it.
 *
 * Returns the naturals that were actually advanced. A learner might produce a
 * string the deck has never heard of, in which case nothing is cleared — and that
 * is fine; the deck only shrinks for words it was already targeting.
 */
export const clearDeckNaturals = (naturals: readonly string[]): string[] => {
  if (naturals.length === 0) return [];
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE fumble SET cleared_at = ?
      WHERE natural = ? AND cleared_at IS NULL`,
  );
  const cleared: string[] = [];
  for (const raw of naturals) {
    const natural = typeof raw === "string" ? raw.trim() : "";
    if (!natural) continue;
    const info = stmt.run(now, natural);
    if (info.changes > 0) cleared.push(natural);
  }
  return cleared;
}

/**
 * The deck the rail shows, ordered worst offenders first.
 *
 * Cleared fumbles drop out of the aggregation entirely — the deck shrinks as the
 * learner produces words unprompted. A learner who fumbled the same natural form
 * three times across three turns sees one entry, not three: the count is the
 * aggregation, the entries are the words. Ties on count break on recency, so a
 * fumble that happened this session edges out one from a session ago.
 */
export function getFumbleDeck(): FumbleDeckEntry[] {
  const rows = db
    .prepare(
      `SELECT natural, COUNT(*) AS count, MAX(created_at) AS last_seen_at
         FROM fumble
        WHERE cleared_at IS NULL
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
 * room for that. The list deliberately includes cleared fumbles — a moment is a
 * moment, and clearing a word later does not rewrite the sprint that produced it.
 */
export function getSprintFumbles(sprintId: string): Fumble[] {
  const rows = db
    .prepare(
      `SELECT * FROM fumble WHERE sprint_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(sprintId) as FumbleRow[];
  return rows.map(toFumble);
}

/**
 * Mark every uncleared, undrilled moment of one natural form as drilled.
 *
 * Called from inside the turn transaction after the learner successfully retried
 * a drilled phrase. The flag tracks *which moments* were drilled on, so the deck
 * card can show a learner which words still need work versus the ones they have
 * already been walked through. Cleared fumbles are skipped because they have
 * already left the deck — stamping them would write a truth that no longer
 * appears anywhere the learner reads.
 *
 * Returns the number of rows actually flipped. A natural that is not on the
 * deck returns 0; the caller can use that to detect a drill that did not match
 * a real moment, which is the right signal that the model chose to drill on
 * something the deck had not seen before.
 */
export const markFumblesDrilledByNatural = (natural: string, sprintId: string): number => {
  const trimmed = natural.trim();
  if (!trimmed) return 0;
  const info = db
    .prepare(
      `UPDATE fumble SET drilled = 1
        WHERE natural = ? AND sprint_id = ? AND cleared_at IS NULL AND drilled = 0`,
    )
    .run(trimmed, sprintId);
  return info.changes;
};

/**
 * The single fumble the sprint-end drill should retry.
 *
 * The spec calls it the "worst" fumble, with the gloss "while it's still fresh".
 * Recency is the closest measurable proxy for fresh, and the freshest failure is
 * also the most likely one to be on the learner's mind — which is exactly when
 * a retry has leverage. An empty sprint returns null; the caller turns that
 * into no drill.
 */
export function worstFumbleForSprint(sprintId: string): Fumble | null {
  const row = db
    .prepare(
      `SELECT * FROM fumble
        WHERE sprint_id = ? AND cleared_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(sprintId) as FumbleRow | undefined;
  return row ? toFumble(row) : null;
}
