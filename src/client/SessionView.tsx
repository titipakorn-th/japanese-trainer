"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnnotatedText } from "./AnnotatedText";
import { DebriefCard } from "./DebriefCard";
import { SprintTrack } from "./SprintTrack";
import { StreamedText } from "./StreamedText";
import { useTurn } from "./useTurn";
import { meanResponseMs } from "@/lib/measure";
import type { Debrief, SessionState, Sprint, Turn } from "@/lib/types";

const BUDGET_MS = 900;

/**
 * The conversation surface.
 *
 * `initial` comes from the server on first render, which is what makes a reload
 * resume rather than restart. Everything after that is a projection of server
 * state: a turn appears in the transcript when the server commits it, and a
 * failed call leaves the transcript exactly as it was.
 *
 * The session moves through its sprints on its own. When a scene is spent, the
 * partner closes it, the debrief card lands in the transcript, and the next scene
 * opens — all inside one request, and none of it is something the learner has to
 * press.
 */
export function SessionView({ initial }: { initial: SessionState }) {
  const { session, turns: seeded } = initial;

  const [turns, setTurns] = useState<Turn[]>(seeded);
  const [sprints, setSprints] = useState<Sprint[]>(initial.sprints);
  const [active, setActive] = useState<Sprint | null>(initial.activeSprint);
  // A session recorded before sessions had more than one scene to them has no live
  // scene to play. It is finished, and the composer would only collect a turn the
  // server will refuse.
  const [ended, setEnded] = useState(
    initial.session.status === "ended" || initial.activeSprint === null,
  );
  const noScene = initial.session.status === "active" && initial.activeSprint === null;
  const [abandoned, setAbandoned] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingLearner, setPendingLearner] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  /** What the in-flight turn is for, so Retry can repeat it. */
  const [attempt, setAttempt] = useState<string | null>(null);
  const openedFor = useRef<string | null>(null);

  const { stream, send, clearFailure } = useTurn(session.id);
  const busy = stream.phase === "streaming";
  // Each debrief knows the sequence number of the turn it belongs after, so the
  // transcript can drop the card in the right place without a second structure.
  const debriefs = new Map<number, Debrief>(
    sprints.flatMap((s) => (s.debrief ? [[s.debrief.afterSeq, s.debrief] as const] : [])),
  );

  const run = useCallback(
    async (text: string | null) => {
      setAttempt(text);
      if (text !== null) setPendingLearner(text);

      const result = await send(text);

      if (result.ok && result.committed.length > 0) {
        for (const entry of result.committed) {
          setTurns((prev) => [...prev, ...(entry.learnerTurn ? [entry.learnerTurn] : []), entry.turn]);
        }
        const last = result.committed[result.committed.length - 1]!;
        setActive(last.sprint.status === "active" ? last.sprint : null);
        setSprints((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const entry of result.committed) byId.set(entry.sprint.id, entry.sprint);
          return [...byId.values()].sort((a, b) => a.seq - b.seq);
        });
        setEnded(last.status === "ended");
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
    if (seeded.length > 0 || ended || openedFor.current === session.id) return;
    openedFor.current = session.id;
    void run(null);
  }, [session.id, seeded.length, ended, run]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || busy || ended) return;
    void run(text);
  }, [draft, busy, ended, run]);

  const retry = useCallback(() => {
    if (busy) return;
    clearFailure();
    void run(attempt);
  }, [attempt, busy, clearFailure, run]);

  const end = useCallback(async () => {
    if (busy) return;
    setAbandoned(true);
    const response = await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
    if (!response.ok) {
      setAbandoned(false);
      return;
    }
    const state = (await response.json()) as SessionState;
    setSprints(state.sprints);
    setActive(null);
    setTurns(state.turns);
    setEnded(true);
  }, [busy, session.id]);

  const totalTurns = turns.filter((t) => t.role === "learner").length;
  const average = meanResponseMs(turns);

  return (
    <div className="shell">
      <div className="chat">
        <header className="head">
          <div className="heading">
            <div className="title jp">{active ? active.brief.persona : session.scenario.title}</div>
            <div className="sub jp">{active ? active.brief.goal : ""}</div>
          </div>
          <SprintTrack sprints={sprints} />
          <div className="grow" />
          <LatencyChip ms={latency} live={busy} />
          {ended ? (
            <Link className="quit" href="/">
              New session
            </Link>
          ) : (
            <EndButton onEnd={end} busy={busy} />
          )}
        </header>

        <Feed
          turns={turns}
          debriefs={debriefs}
          pendingLearner={pendingLearner}
          stream={stream.text}
          busy={busy}
        />

        {ended ? (
          <div className="wrap">
            <h2>{wrapTitle(noScene, abandoned)}</h2>
            {noScene ? (
              <p>
                It was recorded before a session was made of several scenes, so there is no scene
                left to play. Everything in it is still here.
              </p>
            ) : (
              <p>
                {sprints.filter((s) => s.status === "closed").length} of {sprints.length} sprints,{" "}
                {totalTurns} turns,{" "}
                {average === null
                  ? "no answer times recorded."
                  : `${Math.round(average / 1000)}s to answer on average.`}
              </p>
            )}
            <p className="note">
              Every sprint's debrief is in the transcript above, and the session is still on this
              machine — scroll back through it whenever you want.
            </p>
            <Link className="again" href="/">
              Start another session
            </Link>
          </div>
        ) : (
          <div className="composer">
            {stream.failure ? (
              <div className="failure" role="alert">
                <span className="grow">
                  {stream.failure.message}{" "}
                  {attempt === null ? "The opening line was not sent." : "Your turn was not sent."}
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
        )}
      </div>

      <Rail sprints={sprints} turns={turns} latency={latency} />
    </div>
  );
}

/**
 * Ending a session is one click, not a dialog: the learner is mid-conversation
 * and the worst outcome here is a session that stopped early, which is not
 * worth a modal asking about. The second click is the confirmation, and the panel
 * that replaces the composer says plainly that the work was kept.
 */
function EndButton({ onEnd, busy }: { onEnd: () => void; busy: boolean }) {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);

  if (!asking) {
    return (
      <button className="quit" type="button" onClick={() => setAsking(true)} disabled={busy}>
        End session
      </button>
    );
  }
  return (
    <span className="asking">
      <button className="quit danger" type="button" onClick={onEnd} disabled={busy}>
        Keep progress and end
      </button>
      <button className="quit" type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

function wrapTitle(noScene: boolean, abandoned: boolean): string {
  if (noScene) return "This session has ended";
  return abandoned ? "Ended early — everything is kept" : "That's the session";
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
  debriefs,
  pendingLearner,
  stream,
  busy,
}: {
  turns: Turn[];
  debriefs: Map<number, Debrief>;
  pendingLearner: string | null;
  stream: string;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const count = turns.length;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, pendingLearner, stream]);

  // Nothing streamed yet, so the partner has not said anything. Say so, rather
  // than leaving a gap the learner cannot tell from a frozen screen.
  const composing = busy && !stream;

  return (
    <div className="feed" ref={ref}>
      {turns.map((turn) => (
        <div key={turn.id} className="exchange">
          <article className={`turn ${turn.role}`}>
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
            {turn.role === "learner" && turn.responseMs !== null ? (
              <div className="timing">{Math.round(turn.responseMs / 1000)}s to answer</div>
            ) : null}
          </article>
          {debriefs.has(turn.seq) ? <DebriefCard debrief={debriefs.get(turn.seq)!} /> : null}
        </div>
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
          <div className="thinking">{count ? "…" : "walking over…"}</div>
        </article>
      ) : null}

      {!count && !busy ? <p className="quiet-empty">This session has not started yet.</p> : null}
    </div>
  );
}

function Rail({
  sprints,
  turns,
  latency,
}: {
  sprints: Sprint[];
  turns: Turn[];
  latency: number | null;
}) {
  const counts: Record<"new" | "grammar", number> = { new: 0, grammar: 0 };
  for (const turn of turns) {
    for (const marker of turn.markers) {
      if (marker.kind === "new" || marker.kind === "grammar") counts[marker.kind] += 1;
    }
  }
  const learner = turns.filter((t) => t.role === "learner");
  const meanMs = meanResponseMs(turns);
  const active = sprints.find((s) => s.status === "active");
  const done = sprints.filter((s) => s.status === "closed").length;
  const next = sprints.find((s) => s.status !== "closed" && s.seq > (active?.seq ?? 0));

  return (
    <aside className="rail">
      <div className="card">
        <h2>This session</h2>
        <SprintTrack sprints={sprints} full />
        <div className="stat">
          <span>Sprints</span>
          <b>
            {done} of {sprints.length}
          </b>
        </div>
        <div className="stat">
          <span>Your turns</span>
          <b>{learner.length}</b>
        </div>
        <div className="stat">
          <span>Average answer time</span>
          <b>{meanMs === null ? "—" : `${Math.round(meanMs / 1000)}s`}</b>
        </div>
        <div className="stat">
          <span>New Words met</span>
          <b>{counts.new}</b>
        </div>
        <div className="stat">
          <span>Grammar Point uses</span>
          <b>{counts.grammar}</b>
        </div>
        {next ? (
          <p className="note">
            Next up: <span className="jp">{next.brief.persona}</span>
            <br />
            <span className="jp">{next.brief.goal}</span>
          </p>
        ) : null}
        <p className="note">
          First sentence on screen: {latency === null ? "—" : `${Math.round(latency)}ms`} (budget
          900ms). Timed in the browser, from submit to the first sentence being complete to read.
        </p>
      </div>

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
    </aside>
  );
}
