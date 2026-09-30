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
 * Defaults land on the spec's shape: a 6-minute sprint, five of them, and a
 * 30-minute session. The turn count is a cap on a very brisk exchange, not the
 * thing that ends a scene — see `closeSprint`.
 */

const MINUTE = 60_000;

/**
 * A positive number from the environment, or the fallback.
 *
 * Shared rather than reimplemented per module because the alternative is two
 * copies of the same three-line reader drifting apart on what counts as set — and
 * "is this tunable actually set?" is not a question to answer two ways.
 */
export function envNum(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function pacing(): Pacing {
  return {
    sprintTurns: Math.round(envNum(process.env.SPRINT_TURNS, 20)),
    sprintMs: envNum(process.env.SPRINT_MS, 6 * MINUTE),
    sessionMs: envNum(process.env.SESSION_MS, 30 * MINUTE),
  };
}

/**
 * Sprints to a session, held inside the 4–6 the spec promises.
 *
 * The floor is the spec's, not a preference: CONTEXT.md defines a session as 4–6
 * sprints, and a three-sprint session breaks that promise silently. A family with
 * fewer than four scenes therefore repeats one, which is why every family ships
 * five — the clamp is a backstop against a thin catalog, not a way to plan one.
 */
export function sprintsPerSession(available: number): number {
  const asked = Math.round(envNum(process.env.SPRINTS_PER_SESSION, 5));
  return Math.max(1, Math.min(6, Math.max(4, Math.min(asked, available))));
}

export interface Closing {
  /** Why a sprint is being closed right now, or null to keep going. */
  endedBy: SprintEnding | null;
}

/**
 * Whether this request is the sprint's last, and why.
 *
 * The clock is checked first, because it is the one that actually decides how long
 * a session lasts. A turn budget cannot: the learner sets the pace, so eight turns
 * is two and a half minutes for a fast learner and seven for a slow one, and a
 * five-sprint session built on it lands anywhere between twelve and forty minutes.
 * The clock is the same six minutes for everyone, so the count is a *cap* — it
 * exists to stop a brisk exchange from running to twenty-five turns inside one
 * scene, and it is the reason `SPRINT_TURNS` is twenty rather than eight.
 *
 * `learnerTurns` counts what is already committed. The cap closes the sprint when
 * it is reached, so the submission that reaches it still gets answered — by the
 * partner's closing line rather than by a fresh question. Ending a scene on a
 * question the learner never gets to answer is the same as losing a turn.
 */
export function closeSprint(
  learnerTurns: number,
  startedAt: number,
  now: number,
  p: Pacing,
): Closing {
  if (now - startedAt >= p.sprintMs) return { endedBy: "sprint-clock" };
  if (learnerTurns >= p.sprintTurns) return { endedBy: "turn-cap" };
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
