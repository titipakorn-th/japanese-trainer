/**
 * The one place that knows how to reach MiniMax, and the one place that knows
 * how to get at the key.
 *
 * Two clients use this — the conversation partner (`minimax.ts`) and the partner's
 * voice (`tts.ts`) — and they have to agree on the host, because they do not
 * actually have a choice: a CN-platform key is rejected by the global host with
 * `2049 invalid api key` and vice versa, so a region set for one call and not
 * the other produces a failure that reads like a stale key and is not.
 */

const HOSTS = {
  cn: "https://api.minimaxi.com",
  global: "https://api.minimax.io",
} as const;

export class MiniMaxAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniMaxAuthError";
  }
}

export function regionHost(): string {
  return process.env.MINIMAX_REGION === "global" ? HOSTS.global : HOSTS.cn;
}

/**
 * A number from the environment, or the fallback when it is absent or nonsense.
 *
 * `Number("")` is 0 and `Number("abc")` is NaN, both of which are finite enough
 * to be mistaken for a value, so the check is explicit about wanting a positive
 * number rather than just a numeric one.
 */
export function positiveNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function requireApiKey(): string {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) {
    throw new MiniMaxAuthError(
      "MINIMAX_API_KEY is not set. Copy .env.example to .env.local and add the key.",
    );
  }
  return key;
}
