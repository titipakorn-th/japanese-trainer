import type { Pacing, SprintEnding } from "@/lib/types";

/**
 * What ends a sprint, and what ends a session.
 *
 * Both are held on two walls, and they are not interchangeable:
 *
 * - **A turn budget.** A sprint runs for a fixed number of learner turns, which
 *   is what actually makes it five to seven minutes. The learner sets the pace
 *   by reading and typing, so wall-clock alone would make a slow learner feel
 *   punished with fewer scenes, and a fast one would blow past thirty minutes.
 * - **A clock.** A session that has been open for thirty minutes ends, and so
 *   does a sprint that has run past its own window. The clock catches the case
 *   the budget cannot see: one very slow turn, or a learner who stops and comes
 *   back twenty minutes later.
 *
 * The clock is checked when a turn is requested, not by a timer. Nothing in this
 * app runs in the background, and a session that quietly ends while nobody is
 * looking is worse than one that ends the moment the learner next speaks.
 *
 * Defaults land on the spec's shape: 8 learner turns per sprint, a 6-minute
 * sprint, a 30-minute session, and 4–6 sprints to a session.
 */

const MINUTE = 60_000;

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function pacing(): Pacing {
  return {
    sprintTurns: Math.round(num(process.env.SPRINT_TURNS, 8)),
    sprintMs: num(process.env.SPRINT_MS, 6 * MINUTE),
    sessionMs: num(process.env.SESSION_MS, 30 * MINUTE),
  };
}

/** Sprints to a session, clamped to the 4–6 the spec asks for. */
export function sprintsPerSession(available: number): number {
  const asked = Math.round(num(process.env.SPRINTS_PER_SESSION, 5));
  return Math.max(1, Math.min(6, Math.max(4, Math.min(asked, available))));
}

export interface Closing {
  /** Why a sprint is being closed right now, or null to keep going. */
  endedBy: SprintEnding | null;
}

/**
 * Whether this request is the sprint's last, and why.
 *
 * `learnerTurns` counts what is already committed. The budget closes the sprint
 * when it is spent, so the submission that spends it still gets answered — by
 * the partner's closing line rather than by a fresh question. Ending a scene on
 * a question the learner never gets to answer is the same as losing a turn.
 */
export function closeSprint(
  learnerTurns: number,
  startedAt: number,
  now: number,
  p: Pacing,
): Closing {
  if (learnerTurns >= p.sprintTurns) return { endedBy: "budget" };
  if (now - startedAt >= p.sprintMs) return { endedBy: "sprint-clock" };
  return { endedBy: null };
}

/**
 * Whether the session itself is out, regardless of how many sprints are left.
 *
 * This outranks the plan: a session that has run past its window ends on the
 * spot, and the debrief says the clock did it rather than claiming a full
 * sequence of scenes.
 *
 * `startedAt` is when practice actually began — the first committed turn — and is
 * null before that. A session that has been created but not started cannot be out
 * of time, however long the record has existed: the learner is owed an opening
 * line, not a debrief of a session that never happened.
 */
export function sessionExpired(startedAt: number | null, now: number, p: Pacing): boolean {
  if (startedAt === null) return false;
  return now - startedAt >= p.sessionMs;
}
