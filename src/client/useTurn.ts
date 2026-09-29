"use client";

import { useCallback, useRef, useState } from "react";
import { firstSentenceEnd } from "@/lib/sentences";
import type { Turn, TurnEvent } from "@/lib/types";

export type TurnPhase = "idle" | "streaming" | "failed";

export interface TurnStream {
  phase: TurnPhase;
  /** The partner's line so far. Provisional until `turn` arrives. */
  text: string;
  failure: { message: string; retryable: boolean } | null;
}

const IDLE: TurnStream = { phase: "idle", text: "", failure: null };

const NOT_SENT: SendResult = {
  ok: false,
  learnerTurn: null,
  turn: null,
  firstSentenceMs: null,
};

export interface SendResult {
  ok: boolean;
  /** The learner's turn, if the server committed one. */
  learnerTurn: Turn | null;
  /** The partner's committed turn. Only meaningful when `ok`. */
  turn: Turn | null;
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
 * has to leave the typed text sitting in the field, and the only way to
 * guarantee that is for the draft to never live in here.
 */
export function useTurn(sessionId: string) {
  const [stream, setStream] = useState<TurnStream>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  /** Serialises turns so two fast submits cannot abort each other. */
  const busyRef = useRef(false);

  const send = useCallback(
    async (text: string | null): Promise<SendResult> => {
      if (busyRef.current) return NOT_SENT;
      busyRef.current = true;

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
          body: JSON.stringify({ text }),
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
        /** What has been streamed so far, for timing the first sentence. */
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
              result = {
                ok: true,
                learnerTurn: event.learnerTurn,
                turn: event.turn,
                firstSentenceMs: firstSentenceMs ?? performance.now() - startedAt,
              };
              setStream({ phase: "idle", text: event.turn.text, failure: null });
            } else if (event.t === "error") {
              setStream({
                phase: "failed",
                text: "",
                failure: { message: event.message, retryable: event.retryable },
              });
            }
          }
        }

        if (result.ok) setStream((prev) => ({ ...prev, phase: "idle" }));
        return result;
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
