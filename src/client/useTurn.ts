"use client";

import { useCallback, useRef, useState } from "react";
import { firstSentenceEnd } from "@/lib/sentences";
import type { Committed, Turn, TurnEvent } from "@/lib/types";

export type TurnPhase = "idle" | "streaming" | "failed";

export interface TurnStream {
  phase: TurnPhase;
  /** The partner's current line so far. Provisional until it is committed. */
  text: string;
  failure: { message: string; retryable: boolean } | null;
}

const IDLE: TurnStream = { phase: "idle", text: "", failure: null };

const NOT_SENT: SendResult = { ok: false, committed: [], firstSentenceMs: null };

export interface SendResult {
  ok: boolean;
  /**
   * Everything the server committed during this request, in order.
   *
   * Usually one. Crossing a sprint boundary commits two — the scene's closing
   * exchange and the next scene's opening — and the debrief rides on the first, so
   * the client can render it between the two. Assuming one exchange per request
   * would drop either the debrief or a whole scene.
   */
  committed: Committed[];
  /**
   * ms from submit until the first sentence was complete in the browser, which is
   * the number the latency budget is written against. Measured here rather than
   * taken from the server: the server can only time up to its own first
   * terminator, which excludes the flush, the trip to the browser, and the paint.
   */
  firstSentenceMs: number | null;
}

/**
 * Drive one turn and hand back only what actually reached the server.
 *
 * The caller keeps the learner's draft. Nothing here clears it: a failed call
 * has to leave the typed text sitting in the field, and the only way to guarantee
 * that is for the draft to never live in here.
 */
export function useTurn(sessionId: string) {
  const [stream, setStream] = useState<TurnStream>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  /** Serialises turns so two fast submits cannot abort each other. */
  const busyRef = useRef(false);
  /**
   * When the partner's last line finished arriving, which is when the learner
   * could start answering. Null after a reload, because the moment the text
   * became readable is not knowable retroactively — and a time from page load
   * would count the learner re-reading the transcript as hesitation.
   */
  const readyAt = useRef<number | null>(null);

  const send = useCallback(
    async (text: string | null): Promise<SendResult> => {
      if (busyRef.current) return NOT_SENT;
      busyRef.current = true;

      const responseMs = readyAt.current === null ? null : performance.now() - readyAt.current;
      readyAt.current = null;

      const controller = new AbortController();
      abortRef.current = controller;
      setStream({ phase: "streaming", text: "", failure: null });

      const fail = (message: string, retryable = true): SendResult => {
        setStream({ phase: "failed", text: "", failure: { message, retryable } });
        return NOT_SENT;
      };

      try {
        const startedAt = performance.now();
        let firstSentenceMs: number | null = null;

        const response = await fetch(`/api/sessions/${sessionId}/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, responseMs }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          return fail(
            response.status === 409
              ? "A turn is already in flight."
              : `The server refused the turn (HTTP ${response.status}).`,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result: SendResult = NOT_SENT;
        const committed: Committed[] = [];
        /** What has been streamed for the line being read right now. */
        let shown = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let event: TurnEvent;
            try {
              event = JSON.parse(trimmed) as TurnEvent;
            } catch {
              continue;
            }

            if (event.t === "delta") {
              shown += event.v;
              setStream((prev) => ({ ...prev, text: shown }));
              if (firstSentenceMs === null && firstSentenceEnd(shown) > 0) {
                firstSentenceMs = performance.now() - startedAt;
              }
            } else if (event.t === "reset") {
              // The server rejected the first attempt; take the retry instead of
              // leaving two half-replies on screen.
              firstSentenceMs = null;
              shown = "";
              setStream((prev) => ({ ...prev, text: "" }));
            } else if (event.t === "done") {
              committed.push({
                learnerTurn: event.learnerTurn,
                turn: event.turn,
                sprint: event.sprint,
                debrief: event.debrief,
                status: event.status,
              });
              result = {
                ok: true,
                committed,
                firstSentenceMs: firstSentenceMs ?? performance.now() - startedAt,
              };
              // The line is now a committed turn in the transcript, so the
              // provisional one goes. The next scene's opening may follow this
              // frame and start streaming into the space it leaves.
              shown = "";
              setStream((prev) => ({ ...prev, text: "" }));
              readyAt.current = performance.now();
            } else if (event.t === "error") {
              setStream({
                phase: "failed",
                text: "",
                failure: { message: event.message, retryable: event.retryable },
              });
            }
          }
        }

        if (result.ok) {
          setStream((prev) => ({ ...prev, phase: "idle" }));
          return result;
        }
        // The stream ended without committing anything: the server hung up, the
        // connection dropped mid-turn, or the request was abandoned. Nothing was
        // written, so the transcript is already right — but the turn has to settle
        // here, because leaving the phase at "streaming" disables the composer for
        // good and strands a half-written line on screen with no way to clear it.
        return fail("The partner's reply was cut off before it finished.");
      } catch (err) {
        if (controller.signal.aborted) {
          setStream(IDLE);
          return NOT_SENT;
        }
        return fail(
          err instanceof Error && err.message
            ? `Lost the connection. ${err.message}`
            : "Lost the connection.",
        );
      } finally {
        busyRef.current = false;
      }
    },
    [sessionId],
  );

  const clearFailure = useCallback(() => {
    setStream((prev) => (prev.phase === "failed" ? { ...prev, failure: null } : prev));
  }, []);

  return { stream, send, clearFailure };
}
