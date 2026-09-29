"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnnotatedText } from "./AnnotatedText";
import { StreamedText } from "./StreamedText";
import { useTurn } from "./useTurn";
import type { SessionState, Turn } from "@/lib/types";

const BUDGET_MS = 900;

/**
 * The conversation surface.
 *
 * `initial.turns` comes from the server on first render, which is what makes a
 * reload resume rather than restart. Everything after that is a projection of
 * server state: a turn appears in the transcript when the server commits it, and
 * a failed call leaves the transcript exactly as it was.
 */
export function SessionView({ initial }: { initial: SessionState }) {
  const { session, turns: seeded } = initial;

  const [turns, setTurns] = useState<Turn[]>(seeded);
  const [draft, setDraft] = useState("");
  const [pendingLearner, setPendingLearner] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  /** What the in-flight turn is for, so Retry can repeat it. */
  const [attempt, setAttempt] = useState<string | null>(null);
  const openedFor = useRef<string | null>(null);

  const { stream, send, clearFailure } = useTurn(session.id);
  const busy = stream.phase === "streaming";

  const run = useCallback(
    async (text: string | null) => {
      setAttempt(text);
      if (text !== null) setPendingLearner(text);

      const result = await send(text);

      if (result.ok && result.turn) {
        setTurns((prev) => [...prev, ...(result.learnerTurn ? [result.learnerTurn] : []), result.turn!]);
        setPendingLearner(null);
        setAttempt(null);
        setDraft("");
        setLatency(result.firstSentenceMs);
      } else {
        // The conversation did not advance. The draft was never touched, so the
        // typed text is still in the field, ready to retry.
        setPendingLearner(null);
      }
    },
    [send],
  );

  // A session with no turns has never had its opening line. Fire it once. A
  // reload mid-opening finds the session still empty, so this has to be safe to
  // run again — a failed opening is retryable from the error banner like any
  // other turn.
  useEffect(() => {
    if (seeded.length > 0 || openedFor.current === session.id) return;
    openedFor.current = session.id;
    void run(null);
  }, [session.id, seeded.length, run]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    void run(text);
  }, [draft, busy, run]);

  const retry = useCallback(() => {
    if (busy) return;
    clearFailure();
    void run(attempt);
  }, [attempt, busy, clearFailure, run]);

  return (
    <div className="shell">
      <div className="chat">
        <header className="head">
          <div>
            <div className="title jp">{session.scenario.title}</div>
            <div className="sub jp">{session.scenario.goal}</div>
          </div>
          <div className="grow" />
          <LatencyChip ms={latency} live={busy} />
          <Link className="quit" href="/">
            Start over
          </Link>
        </header>

        <Feed turns={turns} pendingLearner={pendingLearner} stream={stream.text} busy={busy} />

        <div className="composer">
          {stream.failure ? (
            <div className="failure" role="alert">
              <span className="grow">
                {stream.failure.message} {attempt === null ? "The opening line was not sent." : "Your turn was not sent."}
              </span>
              {stream.failure.retryable ? (
                <button type="button" onClick={retry}>
                  Retry
                </button>
              ) : null}
              <button type="button" onClick={clearFailure}>
                Dismiss
              </button>
            </div>
          ) : null}

          <div className="row">
            <textarea
              className="jp"
              rows={1}
              value={draft}
              disabled={busy}
              placeholder="日本語で返信…"
              aria-label="Reply in Japanese"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button className="send" type="button" onClick={submit} disabled={busy || !draft.trim()}>
              Send
            </button>
          </div>
          <div className="hint">
            Enter to send, Shift+Enter for a new line. Nothing enters the transcript until the
            partner answers.
          </div>
        </div>
      </div>

      <Rail turns={turns} latency={latency} />
    </div>
  );
}

function LatencyChip({ ms, live }: { ms: number | null; live: boolean }) {
  if (live) return <span className="latency">waiting…</span>;
  if (ms === null) return <span className="latency">first sentence —</span>;
  return (
    <span className="latency" data-over-budget={ms > BUDGET_MS ? "1" : "0"}>
      first sentence {Math.round(ms)}ms
    </span>
  );
}

function Feed({
  turns,
  pendingLearner,
  stream,
  busy,
}: {
  turns: Turn[];
  pendingLearner: string | null;
  stream: string;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, pendingLearner, stream]);

  // Nothing streamed yet, so the partner has not said anything. Say so, rather
  // than leaving a gap the learner cannot tell from a frozen screen.
  const composing = busy && !stream;

  return (
    <div className="feed" ref={ref}>
      {turns.map((turn) => (
        <article key={turn.id} className={`turn ${turn.role}`}>
          <div className="who">{turn.role === "partner" ? "Partner" : "You"}</div>
          <div className="bubble jp">
            <AnnotatedText text={turn.text} markers={turn.markers} />
          </div>
          {turn.naturalPhrasing ? (
            <div className="quiet">
              <span className="label">natural</span>
              <span className="phrase jp">{turn.naturalPhrasing}</span>
            </div>
          ) : null}
        </article>
      ))}

      {pendingLearner !== null ? (
        <article className="turn learner pending">
          <div className="who">You</div>
          <div className="bubble jp">{pendingLearner}</div>
        </article>
      ) : null}

      {busy && stream ? (
        <article className="turn partner">
          <div className="who">Partner</div>
          <div className="bubble jp streaming">
            <StreamedText text={stream} />
          </div>
        </article>
      ) : null}

      {composing ? (
        <article className="turn partner">
          <div className="who">Partner</div>
          <div className="thinking">{turns.length ? "…" : "walking over…"}</div>
        </article>
      ) : null}
    </div>
  );
}

function Rail({ turns, latency }: { turns: Turn[]; latency: number | null }) {
  // Fumbles are counted by nothing yet — capturing them is its own slice — so
  // the rail only claims what this one actually tracks.
  const counts: Record<"new" | "grammar", number> = { new: 0, grammar: 0 };
  for (const turn of turns) {
    for (const marker of turn.markers) {
      if (marker.kind === "new" || marker.kind === "grammar") counts[marker.kind] += 1;
    }
  }

  return (
    <aside className="rail">
      <div className="card">
        <h2>Markers</h2>
        <div className="legend-row">
          <span className="marker new sample">
            お酒
            <span className="label">新</span>
          </span>
          <span>New Word — blue, dotted</span>
        </div>
        <div className="legend-row">
          <span className="marker fumble sample">
            それ
            <span className="label">△</span>
          </span>
          <span>Fumble — amber, wavy</span>
        </div>
        <div className="legend-row">
          <span className="marker grammar sample">
            でいいですか
            <span className="label">文</span>
          </span>
          <span>Grammar Point — purple, double</span>
        </div>
        <p className="note">Tap any marker for its reading, meaning, and an example.</p>
      </div>

      <div className="card">
        <h2>This session</h2>
        <div className="stat">
          <span>Messages</span>
          <b>{turns.length}</b>
        </div>
        <div className="stat">
          <span>New Words met</span>
          <b>{counts.new}</b>
        </div>
        <div className="stat">
          <span>Grammar Point uses</span>
          <b>{counts.grammar}</b>
        </div>
        <p className="note">
          First sentence on screen: {latency === null ? "—" : `${Math.round(latency)}ms`} (budget 900ms).
          Timed in the browser, from submit to the first sentence being complete to read.
        </p>
      </div>
    </aside>
  );
}
