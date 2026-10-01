import type { Turn } from "@/lib/types";

/**
 * Measuring the learner, and writing it down.
 *
 * The response time is the one number this product reports back as progress, so
 * the way it is collected and the way it is worded are the same decision, and
 * both live here: the debrief on the server, the per-turn label in the browser,
 * and the summary at the end of a session all read the same turn through here
 * rather than each arriving at their own average.
 *
 * Nothing in this file touches the environment, so the browser can import it.
 */

/**
 * What the partner's first sentence is held to, in the browser, from submit to
 * the first sentence being complete to read. This is the spec's number rather
 * than a target the partner is known to miss — see
 * `docs/adr/0008-first-sentence-budget.md`.
 *
 * It lives here because three places state it: the header chip, the session
 * rail, and the summary line `npm run probe:model` prints. As separate copies
 * they drifted, and the probe went on reporting a budget the design had moved.
 */
export const FIRST_SENTENCE_BUDGET_MS = 1500;

/** The response times recorded on a set of turns, in order. Unmeasured is skipped. */
export function responseTimes(turns: Turn[]): number[] {
  return turns.flatMap((turn) => (turn.role === "learner" && turn.responseMs !== null ? [turn.responseMs] : []));
}

/** The mean of some response times, or null when there were none. */
export function meanMs(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** The mean response time over a set of turns, or null when none were measured. */
export function meanResponseMs(turns: Turn[]): number | null {
  return meanMs(responseTimes(turns));
}

/** An elapsed span, rounded to something a person would say. */
export function humanDuration(ms: number): string {
  if (ms < 45_000) return `${Math.max(1, Math.round(ms / 1000))}秒`;
  const minutes = ms / 60_000;
  if (minutes < 10) return `${Math.round(minutes)}分`;
  return `${Math.round(minutes / 5) * 5}分くらい`;
}

/** A single response time. "24s" while it is still a glance, "1分20秒" after. */
export function humanMs(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
}
