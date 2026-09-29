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
