/**
 * The MiniMax client. The key lives here and never crosses to the browser.
 *
 * One call per turn. It is asked for the partner's line and its annotations in
 * the same response, because splitting them would double the latency the whole
 * product is built around.
 */

const HOSTS = {
  cn: "https://api.minimaxi.com",
  global: "https://api.minimax.io",
} as const;

export class ModelError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "ModelError";
    this.retryable = retryable;
  }
}

export function modelTimeoutMs(): number {
  const raw = Number(process.env.TURN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function modelName(): string {
  return process.env.MINIMAX_MODEL || "abab6.5s-chat";
}

function baseUrl(): string {
  // Point this at a local endpoint to exercise the failure and timeout paths —
  // a refused call, a hanging call — without spending a model call to do it.
  if (process.env.MOCK_MODEL_URL) return process.env.MOCK_MODEL_URL;
  const region = process.env.MINIMAX_REGION === "global" ? "global" : "cn";
  return `${HOSTS[region]}/v1/chat/completions`;
}

interface StreamOptions {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  /**
   * Called with each new slice and with everything received so far.
   *
   * The accumulated text is passed in rather than left to the caller to track:
   * with two buffers in scope, the caller's copy is still empty while the stream
   * is running, and the whole reply silently arrives in one piece at the end.
   */
  onDelta: (chunk: string, accumulated: string) => void;
}

/**
 * Stream one reply.
 *
 * `reasoning_split: true` keeps the model's thinking in `reasoning_content`
 * rather than inline in `content`. Without it a raw <think> block streams
 * straight into the first sentence the learner sees.
 */
export async function streamChat({ messages, signal, onDelta }: StreamOptions): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new ModelError(
      "MINIMAX_API_KEY is not set. Copy .env.example to .env.local and add the key.",
      false,
    );
  }

  const response = await fetch(baseUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: modelName(),
      stream: true,
      reasoning_split: true,
      max_tokens: 700,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ModelError(`The model call failed (HTTP ${response.status}). ${detail.slice(0, 200)}`);
  }
  if (!response.body) {
    throw new ModelError("The model call returned no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;

        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = (event as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
          ?.delta?.content;
        if (!delta) continue;

        raw += delta;
        onDelta(delta, raw);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return raw;
}
