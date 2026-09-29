import { buildSystemPrompt } from "./prompt";
import { ModelError, modelTimeoutMs, streamChat } from "./minimax";
import { parseReply, visibleProse, type ParsedReply } from "./parse";
import { commitExchange, getSession, getTurns } from "./sessions";
import type { TurnEvent } from "@/lib/types";
import { firstSentenceEnd } from "@/lib/sentences";

/**
 * One turn, end to end: prompt, stream, parse, commit — or fail having written
 * nothing.
 *
 * `emit` receives the partner's line as it arrives. Deltas carry only the prose:
 * the trailing metadata block is withheld until the stream ends, so the first
 * sentence reaches the browser without waiting for the annotations.
 */

/** One in-flight turn per session. Single learner, so in-memory is enough. */
const inFlight = new Set<string>();

/** Reserve the session for one turn. False if a turn is already running. */
export function claimTurn(sessionId: string): boolean {
  if (inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);
  return true;
}

export function releaseTurn(sessionId: string): void {
  inFlight.delete(sessionId);
}

/**
 * A reply with no Japanese in it is not a reply. Cheap to check, and it stops the
 * learner being shown an English paragraph in the middle of a conversation.
 * One third is loose on purpose: a reply with a stray English word in it is still
 * a reply, and a threshold high enough to catch that would start rejecting
 * correct Japanese.
 */
const JAPANESE_SHARE = 1 / 3;

function looksJapanese(text: string): boolean {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return false;
  const japanese = chars.match(/[\u3040-\u30ff\u4e00-\u9fff]/g)?.length ?? 0;
  return japanese / chars.length > JAPANESE_SHARE;
}


export async function runTurn(
  sessionId: string,
  learnerText: string | null,
  emit: (event: TurnEvent) => void,
  clientSignal: AbortSignal,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    emit({ t: "error", message: "This session does not exist.", retryable: false });
    return;
  }

  const prior = getTurns(sessionId);
  const system = buildSystemPrompt({
    scenario: session.scenario,
    learnerTurnCount: prior.filter((t) => t.role === "learner").length,
  });

  // The conversation goes back as real chat messages, not as a transcript
  // written into the system prompt. A model handed its own history as prose
  // replies to the first line it sees and ignores everything after it.
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
  ];
  for (const turn of prior) {
    messages.push(
      turn.role === "partner"
        ? { role: "assistant", content: turn.text }
        : { role: "user", content: turn.text },
    );
  }
  messages.push({ role: "user", content: learnerText ?? "（学習者が店に入った）" });

  const started = Date.now();
  const timeout = AbortSignal.timeout(modelTimeoutMs());
  const signal = AbortSignal.any([timeout, clientSignal]);

  let sent = 0;
  let firstSentenceMs: number | null = null;
  /** Whether a whole sentence has already been shown to the learner. */
  let shownSentence = false;

  const call = async (): Promise<ParsedReply> => {
    const raw = await streamChat({
      messages,
      signal,
      onDelta: (_chunk, accumulated) => {
        // Re-derive the visible text from the whole buffer: the correction line
        // and the metadata fence can both open mid-chunk, and anything past
        // either is not the partner's line.
        const prose = visibleProse(accumulated);
        if (prose.length > sent) {
          emit({ t: "delta", v: prose.slice(sent) });
          sent = prose.length;
        }
        if (firstSentenceMs === null && firstSentenceEnd(prose) > 0) {
          firstSentenceMs = Date.now() - started;
          shownSentence = true;
        }
      },
    });
    return parseReply(raw, learnerText);
  };

  try {
    // The first call can come back empty, in the wrong language, or with the
    // annotations first and no prose at all. Retry once — but never retract a
    // sentence the learner is already reading. Once a whole sentence is on
    // screen the reply is good enough to keep, and taking it back would be worse
    // than the defect we were guarding against.
    let parsed = await call();
    if (clientSignal.aborted) return;
    if (!shownSentence && (!parsed.text || !looksJapanese(parsed.text))) {
      await replaceStream();
      parsed = await call();
    }
    if (!parsed.text || !looksJapanese(parsed.text)) {
      throw new ModelError("The partner had nothing usable to say.");
    }

    const { learnerTurn, partnerTurn } = commitExchange(
      sessionId,
      learnerText === null
        ? null
        : {
            role: "learner",
            text: learnerText,
            // A rephrasing of what the learner said, kept under what they said.
            naturalPhrasing: parsed.naturalPhrasing,
            markers: [],
          },
      {
        role: "partner",
        text: parsed.text,
        naturalPhrasing: null,
        markers: parsed.markers,
      },
    );

    emit({
      t: "done",
      turn: partnerTurn,
      learnerTurn,
      firstSentenceMs: firstSentenceMs ?? Date.now() - started,
    });
  } catch (err) {
    if (clientSignal.aborted) return;

    const reason =
      timeout.aborted && !clientSignal.aborted
        ? `The partner took longer than ${Math.round(modelTimeoutMs() / 1000)}s to answer.`
        : err instanceof ModelError
          ? err.message
          : err instanceof Error && err.name === "AbortError"
            ? "The model call was cut short."
            : "The model call failed.";

    emit({
      t: "error",
      message: reason,
      retryable: err instanceof ModelError ? err.retryable : true,
    });
  }

  /** Tell the client to throw away anything the failed attempt streamed. */
  function replaceStream() {
    sent = 0;
    firstSentenceMs = null;
    shownSentence = false;
    emit({ t: "reset" });
  }
}
