"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnnotatedText } from "./AnnotatedText";
import { DebriefCard } from "./DebriefCard";
import { SprintTrack } from "./SprintTrack";
import { SpeakButton } from "./SpeakButton";
import { StreamedText } from "./StreamedText";
import { useTurn } from "./useTurn";
import { FIRST_SENTENCE_BUDGET_MS, meanResponseMs } from "@/lib/measure";
import type {
  Debrief,
  FumbleDeckEntry,
  GrammarPoint,
  SessionState,
  Sprint,
  Turn,
  WordLedger,
} from "@/lib/types";

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
  /**
   * The Fumble Deck as it stood when the page was rendered. Updated to the size
   * the server returned with the most recent commit, so the rail always shows
   * the count the conversation actually earned, including fumbles that landed
   * mid-session.
   */
  const [deckSize, setDeckSize] = useState<number>(initial.fumbleDeckSize);
  /**
   * The deck entries as they stood when the page was rendered, and as the server
   * reports them after each commit. The rail lists the natural forms so the
   * learner knows which words to aim for, and the list shrinks as entries get
   * cleared.
   */
  const [deck, setDeck] = useState<FumbleDeckEntry[]>(initial.fumbleDeck);
  /**
   * The New Word ledger as the server last reported it. Held in state rather than
   * counted from the turns on screen for the same reason the deck is: the client is
   * a projection of the session, and a count the client keeps itself is a count
   * that can disagree with the transcript after a reload.
   */
  const [words, setWords] = useState<WordLedger>(initial.words);
  /** What the in-flight turn is for, so Retry can repeat it. */
  const [attempt, setAttempt] = useState<string | null>(null);
  const openedFor = useRef<string | null>(null);
  /**
   * The session's furigana toggle. The server's value is the source of truth on
   * first render, so a reload resumes into the same state. Subsequent flips go
   * through the PATCH endpoint and optimistically update this state before the
   * round-trip completes.
   */
  const [furiganaOn, setFuriganaOn] = useState<boolean>(initial.furiganaOn);
  /**
   * Surface forms the learner has already tapped to reveal. Seeded from the
   * server, which is the only copy that counts: a reveal is part of the session,
   * so it survives a reload, a fresh tab, and a second browser pointed at the
   * same session. A `ref` is held around it so `reveal` stays a stable callback
   * and the transcript is not re-rendered on every tap.
   */
  const revealedRef = useRef<Set<string>>(new Set(initial.revealedReadings));
  const [, forceRender] = useState(0);
  const reveal = useCallback(
    (surface: string) => {
      const set = revealedRef.current;
      if (set.has(surface)) return;
      // Optimistic: the ruby should appear under the finger, not a round-trip
      // later. The server's post-mutation set replaces ours when it lands, so a
      // reveal made in another tab still converges instead of forking.
      set.add(surface);
      forceRender((n) => n + 1);
      void fetch(`/api/sessions/${session.id}/revealed`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as { revealedReadings: string[] };
          revealedRef.current = new Set(data.revealedReadings);
          forceRender((n) => n + 1);
        })
        .catch((err) => {
          // A reveal that did not land must not stay on screen pretending it
          // did — it would read as "this is the session's state" and the learner
          // would never tap the word again.
          revealedRef.current.delete(surface);
          forceRender((n) => n + 1);
          console.error("reveal failed:", err);
        });
    },
    [session.id],
  );

  const { stream, send, clearFailure } = useTurn(session.id);
  const busy = stream.phase === "streaming";
  // Each debrief knows the sequence number of the turn it belongs after, so the
  // transcript can drop the card in the right place without a second structure.
  const debriefs = new Map<number, Debrief>(
    sprints.flatMap((s) => (s.debrief ? [[s.debrief.afterSeq, s.debrief] as const] : [])),
  );

  /**
   * Whether the last partner turn was a drill awaiting the learner's response.
   *
   * A drill partner turn carries `kind: "drill"` and a `drillNatural`. The
   * learner is expected to type the natural form back, which is what the
   * server's drill-success check is looking for. While a drill is pending the
   * composer stays enabled even if no sprint is active — the boundary drill
   * lives between the closing of one scene and the opening of the next, and
   * the learner is supposed to be able to respond to it during that gap.
   */
  const lastPartnerTurn = [...turns].reverse().find((t) => t.role === "partner");
  const pendingDrill = lastPartnerTurn?.kind === "drill" ? lastPartnerTurn : null;
  // The composer stays open while a drill is pending, even when the session
  // would otherwise read as ended — the drill response is the next event.
  const composerOpen = !ended || pendingDrill !== null;

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
        // Each commit reports the deck size and entries after it landed, so the rail
        // grows only when a fumble actually added a new word and shrinks only
        // when the learner produced one. The number the learner sees is the
        // number the database has, and so are the words on the list.
        const lastCommit = result.committed[result.committed.length - 1]!;
        setDeckSize(lastCommit.fumbleDeckSize);
        setDeck(lastCommit.fumbleDeck);
        // Same on the word budget: a slot fills because a marker landed on a
        // committed turn, and it is the server's ledger because the server is what
        // read the turns.
        setWords(lastCommit.words);
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
    if (!text || busy) return;
    // A pending drill keeps the composer open even after the session has read
    // as ended: the drill response is the next event, and rejecting it because
    // the boundary has already committed would leave the learner staring at a
    // drill prompt with no way to answer it.
    if (ended && !pendingDrill) return;
    void run(text);
  }, [draft, busy, ended, pendingDrill, run]);

  const retry = useCallback(() => {
    if (busy) return;
    clearFailure();
    void run(attempt);
  }, [attempt, busy, clearFailure, run]);

  const end = useCallback(async () => {
    if (busy) return;
    if (pendingDrill) return;
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
  }, [busy, pendingDrill, session.id]);

  /**
   * Flip the session's furigana preference.
   *
   * The server's PATCH is the source of truth — flipping it before the request
   * returns lets the UI feel instant, and on a 404 (the session ended while the
   * learner was looking at it) we revert to whatever the server last said. The
   * revealed set is unaffected: switching modes never un-reveals a word the
   * learner has already checked, so the action is symmetric.
   */
  const toggleFurigana = useCallback(async () => {
    const next = !furiganaOn;
    setFuriganaOn(next);
    try {
      const response = await fetch(`/api/sessions/${session.id}/furigana`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        // The toggle silently reverts when the session has ended; surfacing a
        // banner here would interrupt the conversation for a non-actionable
        // state change.
        if (response.status !== 404) {
          setFuriganaOn(!next);
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
      }
    } catch (err) {
      setFuriganaOn(!next);
      // The toggle is one button; the failure is most likely offline. Let it
      // go for now — the conversation can survive a momentary mis-state and the
      // learner can tap again.
      console.error("furigana toggle failed:", err);
    }
  }, [furiganaOn, session.id]);

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
          <FuriganaToggle on={furiganaOn} onToggle={toggleFurigana} disabled={ended && !pendingDrill} />
          <LatencyChip ms={latency} live={busy} />
          {ended && !pendingDrill ? (
            <Link className="quit" href="/">
              New session
            </Link>
          ) : (
            <EndButton onEnd={end} busy={busy} disabled={pendingDrill !== null} />
          )}
        </header>

        <Feed
          turns={turns}
          debriefs={debriefs}
          pendingLearner={pendingLearner}
          stream={stream.text}
          busy={busy}
          furiganaOn={furiganaOn}
          revealed={revealedRef.current}
          onReveal={reveal}
        />

        {ended && !pendingDrill ? (
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
          <div className="composer" data-drill={pendingDrill ? "1" : "0"}>
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
                placeholder={pendingDrill ? "もう一度言ってみましょう…" : "日本語で返信…"}
                aria-label={pendingDrill ? "Drill response in Japanese" : "Reply in Japanese"}
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
              {pendingDrill
                ? "Say the phrase back to clear it from the deck. The partner is waiting on the retry."
                : "Enter to send, Shift+Enter for a new line. Nothing enters the transcript until the partner answers."}
            </div>
          </div>
        )}
      </div>

      <Rail
        sprints={sprints}
        turns={turns}
        latency={latency}
        deckSize={deckSize}
        deck={deck}
        grammarPoint={session.grammarPoint}
        words={words}
      />
    </div>
  );
}

/**
 * Ending a session is one click, not a dialog: the learner is mid-conversation
 * and the worst outcome here is a session that stopped early, which is not
 * worth a modal asking about. The second click is the confirmation, and the panel
 * that replaces the composer says plainly that the work was kept.
 */
function EndButton({ onEnd, busy, disabled }: { onEnd: () => void; busy: boolean; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);

  // A pending drill is the only state where the End button hides: the drill
  // response is the next event in the session, and abandoning before answering
  // it would leave a deck entry half-cleared. The drill clears itself on the
  // server when the learner submits, so the button comes back on the next paint.
  if (disabled) return null;

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
    <span className="latency" data-over-budget={ms > FIRST_SENTENCE_BUDGET_MS ? "1" : "0"}>
      first sentence {Math.round(ms)}ms
    </span>
  );
}

/**
 * The session-wide reading-aid toggle.
 *
 * Off by default — a reading aid that is always on measures the app's data
 * rather than the learner's reading. The chip makes the current state visible
 * at a glance so the learner does not have to wonder whether a tap-target kanji
 * is the app offering help or the app hiding something.
 */
function FuriganaToggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      className="furi-toggle"
      data-on={on ? "1" : "0"}
      aria-pressed={on}
      aria-label={on ? "Turn furigana off for this session" : "Turn furigana on for this session"}
      onClick={onToggle}
      disabled={disabled}
    >
      <span className="led" aria-hidden="true" />
      <span className="label">読み方</span>
      <span className="state">{on ? "on" : "off"}</span>
    </button>
  );
}

function Feed({
  turns,
  debriefs,
  pendingLearner,
  stream,
  busy,
  furiganaOn,
  revealed,
  onReveal,
}: {
  turns: Turn[];
  debriefs: Map<number, Debrief>;
  pendingLearner: string | null;
  stream: string;
  busy: boolean;
  furiganaOn: boolean;
  revealed: ReadonlySet<string>;
  onReveal: (surface: string) => void;
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
          <article
            className={`turn ${turn.role}${turn.kind === "drill" ? " drill" : ""}`}
            data-kind={turn.kind}
          >
            <div className="who-row">
              <div className="who">{turn.role === "partner" ? "Partner" : "You"}</div>
              {turn.role === "partner" && turn.text.trim() ? (
                <SpeakButton text={turn.text} />
              ) : null}
            </div>
            {turn.kind === "drill" ? (
              <div className="drill-label">drill — say it again</div>
            ) : null}
            <div className="bubble jp">
              <AnnotatedText
                text={turn.text}
                markers={turn.markers}
                furiganaOn={furiganaOn}
                revealed={revealed}
                onReveal={onReveal}
              />
            </div>
            {turn.kind === "drill" && turn.drillNatural ? (
              <div className="drill-target jp">「{turn.drillNatural}」</div>
            ) : null}
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
            <StreamedText
              text={stream}
              furiganaOn={furiganaOn}
              revealed={revealed}
              onReveal={onReveal}
            />
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

/**
 * The session's ten word slots, filling as words are met.
 *
 * A bare count cannot show the thing the issue asks for. "New Words met: 6" is a
 * number the learner has no way to situate; ten slots is a shape they can watch
 * fill, and the empty ones are the honest part — they say the session has four
 * words still to give, which is the thing a learner can actually aim at.
 *
 * The two sources are kept apart rather than summed, because they are not the same
 * kind of word and conflating them would misrepresent what happened. A New Word
 * is a fact the learner has read once. A Deck Word is one they failed before and
 * have now been made to reach for again, and the issue is explicit that this half
 * is the more valuable one. Colour follows the transcript's own markers, so a
 * learner who taps a word in the conversation finds the same blue in the rail.
 *
 * `seenAgain` gets its own badge rather than a colour, because it is a different
 * axis: a word can be new *and* already needed a second time, and folding that
 * into the fill colour would lose the one number that says whether the session is
 * training vocabulary or just reading it.
 */
function WordSlots({ ledger }: { ledger: WordLedger }) {
  const filled = ledger.slots;
  const total = Math.max(ledger.target, filled.length);

  return (
    <div className="word-slots">
      <div className="stat">
        <span>New Words</span>
        <b>
          {filled.length} of {total}
        </b>
      </div>
      <ol className="slot-row" aria-label={`New Words met: ${filled.length} of ${total}`}>
        {Array.from({ length: total }, (_, i) => {
          const slot = filled[i];
          if (!slot) {
            return <li key={`empty${i}`} className="slot empty" aria-hidden="true" />;
          }
          return (
            <li
              key={slot.surface}
              className="slot"
              data-kind={slot.kind}
              data-again={slot.seenAgain ? "1" : "0"}
              title={`${slot.surface}${slot.reading ? ` (${slot.reading})` : ""} — ${
                slot.kind === "deck" ? "from the Fumble Deck" : "new this session"
              }${slot.seenAgain ? ", needed again later" : ""}`}
            >
              <span className="jp">{slot.surface}</span>
            </li>
          );
        })}
      </ol>
      <p className="note">
        {/* Both halves shown against their own target rather than as one total, so a
            session that has filled its new half but none of its deck half is visibly
            half-done rather than invisibly behind. */}
        {ledger.newMet}/{ledger.newTarget} new · {ledger.deckMet}/{ledger.deckTarget} from the deck
        {ledger.seenAgain > 0 ? (
          <>
            {" · "}
            {ledger.seenAgain} needed a second time
          </>
        ) : null}
      </p>
    </div>
  );
}

function Rail({
  sprints,
  turns,
  latency,
  deckSize,
  deck,
  grammarPoint,
  words,
}: {
  sprints: Sprint[];
  turns: Turn[];
  latency: number | null;
  deckSize: number;
  deck: FumbleDeckEntry[];
  grammarPoint: GrammarPoint | null;
  words: WordLedger;
}) {
  // Grammar and deck only. New Words are counted by the ledger the server sends,
  // not here — the rail reading a number off the transcript and the prompt reading
  // a number off the same transcript is exactly the pair that drifts after a
  // reload. `deck` is still counted locally because it counts marker *occurrences*
  // rather than distinct words met, and nothing else reports that.
  const counts: Record<"grammar" | "deck", number> = { grammar: 0, deck: 0 };
  for (const turn of turns) {
    for (const marker of turn.markers) {
      if (marker.kind === "grammar" || marker.kind === "deck") {
        counts[marker.kind] += 1;
      }
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
        <WordSlots ledger={words} />
        <div className="stat">
          <span>Grammar Point uses</span>
          <b>{counts.grammar}</b>
        </div>
        <div className="stat" data-fumble-zero={deckSize === 0 ? "1" : "0"}>
          <span>Fumble Deck</span>
          <b>{deckSize}</b>
        </div>
        {deck.length > 0 ? (
          <ul className="deck-list" aria-label="Deck words to produce this session">
            {deck.map((entry) => (
              <li key={entry.natural} className="deck-chip jp">
                <span className="surface">{entry.natural}</span>
                {entry.count > 1 ? <span className="count">×{entry.count}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="stat">
          <span>Deck Word meets</span>
          <b>{counts.deck}</b>
        </div>
        {next ? (
          <p className="note">
            Next up: <span className="jp">{next.brief.persona}</span>
            <br />
            <span className="jp">{next.brief.goal}</span>
          </p>
        ) : null}
        <p className="note">
          First sentence on screen: {latency === null ? "—" : `${Math.round(latency)}ms`} (budget {FIRST_SENTENCE_BUDGET_MS}ms). Timed in the
          browser, from submit to the first sentence being complete to read.
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
          <span className="marker revisit sample">
            お酒
            <span className="label">再</span>
          </span>
          <span>Seen again — blue, solid</span>
        </div>
        <div className="legend-row">
          <span className="marker deck sample">
            会計
            <span className="label">戻</span>
          </span>
          <span>Deck Word — teal, dashed</span>
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

      {grammarPoint ? (
        <div className="card grammar-point">
          <h2>Grammar Point</h2>
          <div className="gp-pattern jp">{grammarPoint.name}</div>
          <p className="gp-why">{grammarPoint.why}</p>
          <div className="gp-shortens">{grammarPoint.shortens}</div>
          <p className="gp-example">
            <span className="label">例</span>
            <span className="jp">{grammarPoint.example}</span>
          </p>
          <p className="note">
            Used {counts.grammar} {counts.grammar === 1 ? "time" : "times"} so far this session. The
            partner will use it across several more turns in different sentences.
          </p>
        </div>
      ) : null}
    </aside>
  );
}
