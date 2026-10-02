import { db } from "./db";
import { getFumbleDeckSize } from "./fumbles";
import { getTurns } from "./sessions";
import { distinctNewWords } from "@/lib/words";

/**
 * What the learner is walking into.
 *
 * A thirty-minute session is a commitment, and it should be made with the day's
 * state in view rather than by opening the app and finding out mid-conversation.
 * Two numbers earn their place here: how much is already on the Fumble Deck,
 * because that is the work waiting to be done and the session that starts will
 * be built around those words; and how many New Words the last sitting met,
 * because "you met 8 new words last time" is the clearest possible argument for
 * doing it again.
 *
 * Both are counted on the server, from the same store the session itself is
 * written to, so the promise on this screen is the arithmetic the app will
 * actually use rather than a description of it.
 */

export interface LastSessionStats {
  /** When that session ended, for the "last time" framing. */
  endedAt: number;
  /** Distinct New Words the partner introduced. */
  words: number;
  /** Learner turns in it, so the word count has something to sit against. */
  turns: number;
  /** How many learner turns walked away. */
  bailOuts: number;
}

export interface StartStats {
  /** Distinct natural forms the learner still owes. */
  deckSize: number;
  /**
   * Sessions ever started, finished or not. Only used to tell "this would be
   * your first one" apart from "nothing finished yet" — the two want very
   * different sentences on a screen whose job is to encourage a return.
   */
  started: number;
  /**
   * The most recent session that actually finished. Null on a learner who has
   * never finished one — an open session is not "last time", it is now, and
   * quoting its halfway numbers as a completed sitting would be a lie.
   */
  last: LastSessionStats | null;
}

/**
 * The most recent finished session, counted.
 *
 * Ordered by `ended_at` rather than `created_at` so a session started last night
 * and finished this morning is the one that gets reported. Only ended sessions
 * qualify: an open one is being worked on right now and has no honest summary.
 */
export function lastFinishedSession(): LastSessionStats | null {
  const row = db
    .prepare(
      `SELECT id, ended_at FROM session
        WHERE ended_at IS NOT NULL AND status = 'ended'
        ORDER BY ended_at DESC
        LIMIT 1`,
    )
    .get() as { id: string; ended_at: number } | undefined;
  if (!row) return null;

  const turns = getTurns(row.id);
  const learner = turns.filter((t) => t.role === "learner");
  const bailOuts = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fumble WHERE session_id = ? AND reason = 'abandoned'`,
    )
    .get(row.id) as { n: number };

  return {
    endedAt: row.ended_at,
    words: distinctNewWords(turns).length,
    turns: learner.length,
    bailOuts: bailOuts.n,
  };
}

export function startStats(): StartStats {
  const started = db.prepare(`SELECT COUNT(*) AS n FROM session`).get() as { n: number };
  return { deckSize: getFumbleDeckSize(), started: started.n, last: lastFinishedSession() };
}
