import { buildSystemPrompt, type Moment, type PromptContext } from "./prompt";
import { ModelError, modelTimeoutMs, streamChat } from "./minimax";
import {
  parseReply,
  visibleProse,
  type ParsedFumble,
  type ParsedReply,
} from "./parse";
import { readStance, type Spoken, type Stance } from "./stance";
import { buildWordLedger, metWords, newWordAllowance, targetDeckWords } from "./words";
import { closeSprint, sessionExpired, pacing } from "./pacing";
import {
  commitBoundary,
  commitDrillResponse,
  commitExchange,
  findPendingDrillSprint,
  getActiveSprint,
  getSession,
  getSprints,
  getTurns,
  type NewTurn,
} from "./sessions";
import {
  getFumbleDeck,
  getFumbleDeckSize,
  getSessionFumbles,
  insertFumbles,
  worstFumbleForSprint,
  type DetectedFumble,
} from "./fumbles";
import { fumbleMarkers } from "./fumbleMarkers";
import type {
  Marker,
  SessionStatus,
  Sprint,
  SprintEnding,
  Turn,
  TurnEvent,
  WordLedger,
} from "@/lib/types";
import { firstSentenceEnd } from "@/lib/sentences";
import { looksJapanese } from "@/lib/reply";

/**
 * One turn, end to end: prompt, stream, parse, commit — or fail having written
 * nothing.
 *
 * `emit` receives the partner's line as it arrives. Deltas carry only the prose:
 * the trailing metadata block is withheld until the stream ends, so the first
 * sentence reaches the browser without waiting for the annotations.
 *
 * A request does one of two things. Most of the time it is an exchange: the
 * partner answers the learner, in the middle of a scene. When the scene's budget
 * or its clock is spent, the same request becomes a boundary — the partner closes
 * the scene, the debrief is written, and the next scene opens — which is why a
 * request can commit two turns and emit two `done` frames. The learner never
 * presses anything to move between scenes; the app does it when the time is up.
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

export interface TurnInput {
  /** Null asks the partner to open the scene. A string is the learner's reply. */
  text: string | null;
  /**
   * ms from the partner finishing its last line to the learner submitting.
   *
   * Measured in the browser, because that is the only place the moment the text
   * became readable exists. It arrives with the turn and is stored on the
   * learner's turn; a value that is not a plausible measurement is dropped rather
   * than averaged into the number the product reports.
   */
  responseMs: number | null;
}

/** Longer than this is a closed tab, not hesitation. */
const MAX_RESPONSE_MS = 10 * 60_000;

function cleanResponseMs(raw: unknown): number | null {
  // Strictly a number, and strictly in range. `Number(null)` is 0, so a missing
  // timing would otherwise be stored as "answered instantly" — a fabricated
  // measurement in a number the product reports to the learner.
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_RESPONSE_MS) return null;
  return Math.round(raw);
}

/** The next sprint in the plan, or null when this one was the last. */
function nextSprint(sprints: Sprint[], seq: number): Sprint["brief"] | null {
  return sprints.find((s) => s.seq === seq + 1)?.brief ?? null;
}

/**
 * The most recent partner line in a sequence of turns, with a fallback for the
 * case where there isn't one (an opening turn, or a learner reply that the
 * partner never answered).
 *
 * Used both as the situation a fumble happened in (what the learner was
 * reacting to) and as the prompt line a drill has to follow up on. The
 * fallback is the scene's goal so a turn with no partner line still has a
 * sentence to anchor a capture against.
 */
function lastPartnerLine(turns: Turn[], fallback: string): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role === "partner") return t.text;
  }
  return fallback;
}

/** Goals of the scenes already run, so the partner knows where it is. */
function earlierGoals(sprints: Sprint[], before: number): string[] {
  return sprints
    .filter((s) => s.seq < before)
    .map((s) => s.brief.goal)
    .slice(-3);
}

/**
 * The deck words this turn is targeting, as their natural forms.
 *
 * Read fresh each call so a word cleared by the previous turn's `produced` field
 * stops being engineered into the partner's reply. The deck is the only signal
 * the learner has that progress is being made on their weak words, and an
 * already-cleared word staying in the prompt is the same regression as a fumble
 * the model stopped reporting — silence on a fix is the worst place to regress.
 */
function activeDeckWords(): string[] {
  return getFumbleDeck().map((entry) => entry.natural);
}

/**
 * The deck words this turn is putting back in play, capped to the budget. Read
 * fresh each call, and for the reason `targetDeckWords` gives.
 */
function targetedDeckWords(): string[] {
  return targetDeckWords(activeDeckWords());
}

/**
 * The New Word budget as it stands after whatever has just committed, for the
 * rail. Read after the write rather than carried through the call, so a word the
 * model marked on this turn is in the frame the client redraws from.
 */
function committedWords(sessionId: string): WordLedger {
  return buildWordLedger(getTurns(sessionId), getSprints(sessionId).length);
}

/**
 * The two New Word fields every call needs, read fresh from committed turns.
 *
 * Both are derived rather than carried: a counter incremented on commit would
 * disagree with the transcript the moment a turn was reloaded, and the whole
 * point of the ledger is that the prompt and the rail are reading the same
 * committed turns. The cost is two reads per model call, both against a table
 * holding one learner's session.
 */
function wordContext(
  sessionId: string,
  sprint: Sprint | null,
  sprints: Sprint[],
  moment: Moment,
): Pick<PromptContext, "metWords" | "allowance"> {
  const turns = getTurns(sessionId);
  return {
    // A closing line is the one moment with no room for a revisit: it is one
    // short sign-off, and a word woven into it is a word used in the least
    // useful sentence in the sprint.
    metWords: moment === "closing" ? [] : metWords(turns),
    allowance: newWordAllowance(turns, sprint, sprints),
  };
}

/**
 * The line the partner says when asking the learner to retry a specific phrase.
 *
 * Templated rather than model-generated: the drill has to happen in the same
 * request as the closing line, and adding another model call to the boundary
 * would double its latency. The template also makes the cost of a drill visible
 * — every drill follows the same shape, and a learner who has seen one knows
 * what the partner is about to ask before the sentence finishes.
 *
 * The surface is included when it differs from the natural form, so a learner
 * who reached for the English word gets a single sentence that names the word
 * they used and the word they should have used. The model name is omitted
 * deliberately: a fumble may not have a surface (an abandoned turn has nothing
 * to highlight), and adding `「」` around the natural form is the only thing
 * the renderer needs to read it correctly.
 */
function drillPromptLine(natural: string, surface: string | null): string {
  const useSurface = surface && surface.trim() && surface.trim() !== natural.trim();
  const phrase = useSurface ? `${surface}じゃなくて、${natural}` : natural;
  return `あ、${phrase}ですね、もう一度お願いします。`;
}

export async function runTurn(
  sessionId: string,
  input: TurnInput,
  emit: (event: TurnEvent) => void,
  clientSignal: AbortSignal,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    emit({ t: "error", message: "This session does not exist.", retryable: false });
    return;
  }
  if (session.status === "ended") {
    emit({ t: "error", message: "This session has ended.", retryable: false });
    return;
  }

  const learnerText = input.text;
  const responseMs = cleanResponseMs(input.responseMs);

  /**
   * A drill response is the one place a learner input arrives while no sprint is
   * active. The previous partner turn carries a `drill_natural`, the session is
   * between sprints (or in the middle of one whose last line was a drill), and
   * the learner is answering the drill rather than continuing the conversation.
   * Detecting it here, before the `getActiveSprint` check, is what lets the
   * composer accept text on a session that has no live scene.
   */
  const allTurns = getTurns(sessionId);
  const lastPartnerTurn = [...allTurns].reverse().find((t) => t.role === "partner");
  const pendingDrillSprint =
    lastPartnerTurn?.kind === "drill" && learnerText !== null
      ? findPendingDrillSprint(sessionId)
      : null;
  if (pendingDrillSprint && learnerText !== null) {
    await handleDrillResponse(
      sessionId,
      pendingDrillSprint,
      learnerText,
      responseMs,
      emit,
      clientSignal,
    );
    return;
  }

  const sprint = getActiveSprint(sessionId);
  if (!sprint) {
    emit({ t: "error", message: "This session has no scene to play.", retryable: false });
    return;
  }

  const sprints = getSprints(sessionId);
  const inSprint = allTurns.filter((t) => t.sprintId === sprint.id);
  const learnerTurns = inSprint.filter((t) => t.role === "learner").length;

  const now = Date.now();
  const budgets = pacing();
  const spent = closeSprint(learnerTurns, sprint.startedAt ?? now, now, budgets).endedBy;
  // From the first committed turn, not from when the record was written: a
  // session the learner opened and left for twenty minutes is a session that is
  // about to start, not one that is already out of time.
  const outOfTime = sessionExpired(allTurns[0]?.createdAt ?? null, now, budgets);

  /** Deltas sent in this request, for deciding whether a failure has to reset. */
  let sent = 0;
  /** Whether a whole sentence has already been shown to the learner. */
  let shownSentence = false;
  let firstSentenceMs: number | null = null;

  const started = Date.now();
  const timeout = AbortSignal.timeout(modelTimeoutMs());
  const signal = AbortSignal.any([timeout, clientSignal]);

  /**
   * One model call, streamed.
   *
   * The conversation goes back as real chat messages scoped to the scene being
   * played, not as a transcript written into the system prompt. A model handed
   * its own history as prose replies to the first line it sees and ignores
   * everything after it — and a scene's history is a quarter of a session's,
   * which is also a quarter of the prefill to pay.
   */
  const ask = async (ctx: PromptContext, history: Turn[], learnerLine: string): Promise<ParsedReply | null> => {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildSystemPrompt(ctx) },
    ];
    for (const turn of history) {
      messages.push(
        turn.role === "partner"
          ? { role: "assistant", content: turn.text }
          : { role: "user", content: turn.text },
      );
    }
    messages.push({ role: "user", content: learnerLine });

    let sentHere = 0;
    const call = async (): Promise<ParsedReply> => {
      const raw = await streamChat({
        messages,
        signal,
        onDelta: (_chunk, accumulated) => {
          // Re-derive the visible text from the whole buffer: the correction line
          // and the metadata fence can both open mid-chunk, and anything past
          // either is not the partner's line.
          const prose = visibleProse(accumulated);
          if (prose.length > sentHere) {
            emit({ t: "delta", v: prose.slice(sentHere) });
            sentHere = prose.length;
            sent = sentHere;
          }
          if (firstSentenceMs === null && firstSentenceEnd(prose) > 0) {
            firstSentenceMs = Date.now() - started;
            shownSentence = true;
          }
        },
      });
      return parseReply(raw, learnerText);
    };

    // The first call can come back empty, in the wrong language, or with the
    // annotations first and no prose at all. Retry once — but never retract a
    // sentence the learner is already reading. Once a whole sentence is on
    // screen the reply is good enough to keep, and taking it back would be worse
    // than the defect we were guarding against.
    let parsed = await call();
    // A hung-up client gets nothing written, so an aborted call returns null rather
    // than a reply the caller might commit: the checks below are the only thing
    // standing between a truncated stream and a half turn in the transcript.
    if (clientSignal.aborted) return null;
    if (!shownSentence && (!parsed.text || !looksJapanese(parsed.text))) {
      sentHere = 0;
      firstSentenceMs = null;
      shownSentence = false;
      emit({ t: "reset" });
      parsed = await call();
    }
    if (!parsed.text || !looksJapanese(parsed.text)) {
      throw new ModelError("The partner had nothing usable to say.");
    }
    return parsed;
  };

  const learnerTurn = (text: string, naturalPhrasing: string | null, fumbles: ParsedFumble[] = []): NewTurn & { responseMs: number | null } => ({
    role: "learner",
    text,
    naturalPhrasing,
    // Fumble markers anchor against the learner's own text, which is what makes
    // them useful: tapping the underlined word tells the learner what they should
    // have said, in the place where they actually said the wrong thing.
    markers: fumbleMarkers(text, fumbles),
    responseMs,
  });

  try {
    if (spent === null && !outOfTime) {
      // An ordinary exchange in the middle of a scene. A scene that has not
      // spoken yet is being opened, which is the only moment the learner has
      // nothing to react to.
      const opening = inSprint.length === 0;

      // The stance reads the learner's turns, and the one being answered is not
      // committed yet — it commits with the reply, or not at all. So the text
      // just submitted has to be added by hand, or the detector is deciding on
      // what the learner said *last* time and a "what is this word called" gets
      // answered as an ordinary turn.
      const said: Spoken[] =
        learnerText === null
          ? inSprint
          : [...inSprint, { role: "learner", text: learnerText, naturalPhrasing: null, responseMs }];
      const stance: Stance = opening ? "plain" : readStance(said).stance;
      // Named once because the prompt's moment and the word budget's notion of the
      // moment have to be the same one, and deriving it twice is how they stop
      // being.
      const moment = (opening && learnerText === null ? "opening" : "reply") as Moment;

      const parsed = await ask(
        {
          brief: sprint.brief,
          moment,
          stance,
          earlier: earlierGoals(sprints, sprint.seq),
          deckWords: targetedDeckWords(),
          grammarPoint: session.grammarPoint,
          ...wordContext(sessionId, sprint, sprints, moment),
        },
        inSprint,
        learnerText ?? "（学習者が来た）",
      );
      if (parsed === null) return;

      // The situation a fumble happened in is the partner's last line — what the
      // learner was responding to when they reached for the wrong word. Captured
      // here, not deeper inside `commitExchange`, because the closing call below
      // uses the same field and a single source is easier to keep honest.
      const situation = lastPartnerLine(inSprint, sprint.brief.goal);
      const capture =
        learnerText !== null && parsed.fumbles.length > 0
          ? { detected: parsed.fumbles, situation, learnerSaid: learnerText }
          : null;

      const { learnerTurn: written, partnerTurn } = commitExchange(
        sessionId,
        learnerText === null ? null : learnerTurn(learnerText, parsed.naturalPhrasing, parsed.fumbles),
        {
          role: "partner",
          text: parsed.text,
          naturalPhrasing: null,
          markers: parsed.markers,
          // A model-issued drill on a fumble the model just reported. The next
          // learner turn is the drill response, which `runTurn` will detect and
          // route through `handleDrillResponse`. Without this field the drill
          // would be committed as a normal turn and the partner would have
          // broken character without the transcript knowing it.
          drillNatural: parsed.drill?.natural ?? null,
        },
        sprint,
        capture,
        // Deck clearance rides the same transaction as the turn via the
        // `clearDeck` parameter on `commitExchange` — a learner turn on disk and
        // a deck that did not shrink between them is impossible. The ADR 0006
        // promise is enforced by where the call happens, not by a post-commit
        // step that could be interrupted.
        parsed.produced.length > 0 ? parsed.produced : null,
      );

      const fumbleDeck = getFumbleDeck();
      const sessionFumbles = getSessionFumbles(sessionId);

      emit({
        t: "done",
        learnerTurn: written,
        turn: partnerTurn,
        firstSentenceMs: firstSentenceMs ?? Date.now() - started,
        sprint,
        debrief: null,
        status: "active",
        fumbleDeckSize: fumbleDeck.length,
        fumbleDeck,
        words: committedWords(sessionId),
        fumbles: sessionFumbles,
      });
      return;
    }

    // The scene is over. Close it, and open the next one in the same request.
    //
    // The clock outranks the plan: a session past its window ends here rather
    // than opening another scene it has no time for. Both model calls happen
    // before anything is written, so a failure in either one leaves the learner
    // exactly where they were, still mid-scene, with the same draft in the field.
    const endedBy: SprintEnding = outOfTime ? "session-clock" : (spent as SprintEnding);
    const next = outOfTime ? null : nextSprint(sprints, sprint.seq);
    const history = inSprint;
    const line = learnerText ?? "（学習者が来た）";

    const closing = await ask(
      {
        brief: sprint.brief,
        moment: "closing",
        stance: "plain",
        earlier: earlierGoals(sprints, sprint.seq),
        deckWords: targetedDeckWords(),
        grammarPoint: session.grammarPoint,
        ...wordContext(sessionId, sprint, sprints, "closing"),
      },
      history,
      line,
    );
    if (closing === null) return;

    const opening = next
      ? await ask(
          {
            brief: next,
            moment: "opening",
            stance: "plain",
            earlier: earlierGoals(sprints, sprint.seq + 1),
            deckWords: targetedDeckWords(),
            grammarPoint: session.grammarPoint,
            // The scene is a brief, not an open sprint, so it has no words in it
            // yet and takes the full ceiling. What it does need is the words the
            // scenes before it met, which is what the revisit block is for.
            ...wordContext(sessionId, null, sprints, "opening"),
          },
          [],
          "（学習者が来た）",
        )
      : null;
    // Only a scene that was asked for can be abandoned mid-call. When there is no
    // next scene the null is the plan running out, which is how a session ends.
    if (next && opening === null) return;

    // The closing learner's turn is still in scope for fumble capture. Its
    // situation is the partner's last line in the closing scene — same field as
    // a mid-scene reply, so the debrief and the deck read the same way.
    const closingSituation = lastPartnerLine(history, sprint.brief.goal);
    const fumbleCapture =
      learnerText !== null && closing.fumbles.length > 0
        ? { detected: closing.fumbles, situation: closingSituation, learnerSaid: learnerText }
        : null;

    /**
     * Sprint-end drill on the worst fumble of the closing scene.
     *
     * The drill is the only piece of the boundary that depends on something
     * other than the model call — it is computed from the fumble table, not
     * from the partner's reply. This is the deliberate choice: the closing
     * call is already what the partner said; deciding what to drill is a
     * separate judgement that should not ride the same call.
     *
     * No drill is issued when there is no fumble, when the session clock
     * is what ended the sprint (the closing line of a session-clock ending
     * does not invite a retry — the session is over), or when there is no
     * next scene to open into. Otherwise we issue exactly one drill, on the
     * freshest uncleared fumble.
     */
    const worstFumble =
      endedBy === "session-clock" || !next ? null : worstFumbleForSprint(sprint.id);
    const drill = worstFumble
      ? {
          text: drillPromptLine(worstFumble.natural, worstFumble.surface || null),
          natural: worstFumble.natural,
        }
      : null;

    const result = commitBoundary(sessionId, sprint, {
      learner: learnerText === null ? null : learnerTurn(learnerText, closing.naturalPhrasing, closing.fumbles),
      closing: { role: "partner", text: closing.text, naturalPhrasing: null, markers: closing.markers },
      endedBy,
      next,
      opening: opening
        ? { role: "partner", text: opening.text, naturalPhrasing: null, markers: opening.markers }
        : null,
      fumbles: fumbleCapture,
      // The closing learner's turn can produce a deck word too. Clearance
      // rides the boundary transaction for the same atomicity reason as a
      // mid-scene reply.
      clearDeck: closing.produced.length > 0 ? closing.produced : null,
      drill,
    });

    const status = result.nextSprint ? "active" : "ended";
    const fumbleDeck = getFumbleDeck();
    const sessionFumbles = getSessionFumbles(sessionId);
    emit({
      t: "done",
      learnerTurn: result.learnerTurn,
      turn: result.closingTurn,
      firstSentenceMs: firstSentenceMs ?? Date.now() - started,
      sprint: {
        ...sprint,
        status: "closed",
        endedAt: result.debrief.endedAt,
        endedBy,
        debrief: result.debrief,
      },
      debrief: result.debrief,
      status,
      fumbleDeckSize: fumbleDeck.length,
      fumbleDeck,
      words: committedWords(sessionId),
      fumbles: sessionFumbles,
    });

    if (result.drillTurn) {
      emit({
        t: "done",
        learnerTurn: null,
        turn: result.drillTurn,
        firstSentenceMs: Date.now() - started,
        sprint: {
          ...sprint,
          status: "closed",
          endedAt: result.debrief.endedAt,
          endedBy,
          debrief: result.debrief,
        },
        debrief: result.debrief,
        status,
        fumbleDeckSize: fumbleDeck.length,
        fumbleDeck,
        words: committedWords(sessionId),
        fumbles: sessionFumbles,
      });
    }

    if (result.nextSprint && result.openingTurn) {
      emit({
        t: "done",
        learnerTurn: null,
        turn: result.openingTurn,
        firstSentenceMs: Date.now() - started,
        sprint: result.nextSprint,
        debrief: null,
        status,
        fumbleDeckSize: fumbleDeck.length,
        fumbleDeck,
        words: committedWords(sessionId),
        fumbles: sessionFumbles,
      });
    }
  } catch (err) {
    if (clientSignal.aborted) return;

    // Nothing was written, so the transcript behind the learner is unchanged. If
    // half a reply was on screen, take it back — unless it was a whole sentence,
    // which the learner has already read.
    if (sent > 0 && !shownSentence) emit({ t: "reset" });

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
}

/**
 * One drill response: commit the learner turn, evaluate success, then continue
 * the conversation in the right place.
 *
 * The drill belongs to one of two contexts:
 *
 * - **Mid-conversation drill**: the drill partner turn is the last turn of the
 *   active sprint. The continuation is a normal partner reply in the same
 *   scene, prompted by the same model call architecture as any other reply.
 * - **Sprint-end drill**: the drill partner turn is the last turn of a closed
 *   sprint, issued at the boundary so the worst fumble of the scene got one
 *   immediate retry. The continuation is the next sprint's opening line, run
 *   as its own scene.
 *
 * Distinguishing the two is just a matter of which sprint row holds the drill
 * partner turn. A closed sprint means the drill was the boundary drill; the
 * next call has to be an opening, not a reply.
 */
async function handleDrillResponse(
  sessionId: string,
  drillSprint: Sprint,
  learnerText: string,
  responseMs: number | null,
  emit: (event: TurnEvent) => void,
  clientSignal: AbortSignal,
): Promise<void> {
  const sprints = getSprints(sessionId);
  const isSprintEnd = drillSprint.status === "closed";

  const started = Date.now();
  const timeout = AbortSignal.timeout(modelTimeoutMs());
  const signal = AbortSignal.any([timeout, clientSignal]);

  /** Deltas for the partner continuation that follows the drill response. */
  let sent = 0;
  let shownSentence = false;
  let firstSentenceMs: number | null = null;

  // The drill response itself commits first, before any model call. A failed
  // model call must not lose the learner's typed answer — they have already
  // answered, the transcript owes them the row.
  const { learnerTurn: written, drilled } = commitDrillResponse(
    sessionId,
    drillSprint.id,
    learnerText,
    responseMs,
  );
  const fumbleDeck = getFumbleDeck();
  const sessionFumbles = getSessionFumbles(sessionId);

  /**
   * Pick the sprint the partner's continuation belongs to.
   *
   * Mid-conversation drill: the same sprint that held the drill partner turn.
   * The continuation is a normal reply in the same scene — the model has just
   * been asked to break character briefly and is back in role now.
   *
   * Sprint-end drill: the next scene. The boundary has already opened it and
   * committed the opening line, so the next partner turn is a reply to the
   * learner rather than a fresh opening. `getActiveSprint` is the right call
   * here — calling `openSprint` again would re-run its `UPDATE sprint SET
   * status='active', started_at=?` statement, which silently resets the
   * scene's clock to the moment the drill response arrived. The drill is
   * already a clock tax on the learner; the scene's clock should keep the
   * opening line as its origin.
   */
  const targetSprint: Sprint | null = isSprintEnd
    ? getActiveSprint(sessionId)
    : drillSprint;
  if (!targetSprint) {
    // The boundary drill is only emitted when there is a next scene to open
    // into (see the carve-out in the boundary code), so reaching here means
    // the session has been abandoned between the boundary and the drill
    // response. The drill response is on the transcript; the wrap panel
    // takes over once the client renders `status: "ended"`.
    emit({
      t: "done",
      learnerTurn: written,
      turn: lastPartnerOfSprint(drillSprint),
      firstSentenceMs: Date.now() - started,
      sprint: drillSprint,
      debrief: null,
      status: "ended",
      fumbleDeckSize: fumbleDeck.length,
      fumbleDeck,
      words: committedWords(sessionId),
      fumbles: sessionFumbles,
    });
    void drilled;
    return;
  }

  // The history passed to the model is the sprint's prior turns — including
  // the drill partner turn, since that is the last line the partner said,
  // and excluding the drill response we just committed, which is the current
  // user message. For sprint-end drills, the prior turns are the next scene's
  // opening line, which the boundary already committed.
  const allTurns = getTurns(sessionId);
  const sprintTurns = allTurns
    .filter((t) => t.sprintId === targetSprint.id)
    .filter((t) => t.id !== written.id);

  const ask = async (ctx: PromptContext, history: Turn[], learnerLine: string): Promise<ParsedReply | null> => {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildSystemPrompt(ctx) },
    ];
    for (const turn of history) {
      messages.push(
        turn.role === "partner"
          ? { role: "assistant", content: turn.text }
          : { role: "user", content: turn.text },
      );
    }
    messages.push({ role: "user", content: learnerLine });

    let sentHere = 0;
    const call = async (): Promise<ParsedReply> => {
      const raw = await streamChat({
        messages,
        signal,
        onDelta: (_chunk, accumulated) => {
          const prose = visibleProse(accumulated);
          if (prose.length > sentHere) {
            emit({ t: "delta", v: prose.slice(sentHere) });
            sentHere = prose.length;
            sent = sentHere;
          }
          if (firstSentenceMs === null && firstSentenceEnd(prose) > 0) {
            firstSentenceMs = Date.now() - started;
            shownSentence = true;
          }
        },
      });
      return parseReply(raw, learnerText);
    };

    let parsed = await call();
    if (clientSignal.aborted) return null;
    if (!shownSentence && (!parsed.text || !looksJapanese(parsed.text))) {
      sentHere = 0;
      firstSentenceMs = null;
      shownSentence = false;
      emit({ t: "reset" });
      parsed = await call();
    }
    if (!parsed.text || !looksJapanese(parsed.text)) {
      throw new ModelError("The partner had nothing usable to say.");
    }
    return parsed;
  };

  try {
    const earlier = earlierGoals(sprints, targetSprint.seq);
    // Both mid-conversation and sprint-end drills pass the drill response as
    // the user message — the model needs to know what the learner just said
    // before it can produce a continuation. Sprint-end drills model a
    // "reply" rather than an "opening" because the next scene's opening line
    // was already committed by the boundary.
    const parsed = await ask(
      {
        brief: targetSprint.brief,
        moment: "reply",
        stance: "plain",
        earlier,
        deckWords: targetedDeckWords(),
        grammarPoint: getSession(sessionId)?.grammarPoint ?? null,
        ...wordContext(
          sessionId,
          targetSprint,
          sprints,
          isSprintEnd ? "opening" : "reply",
        ),
      },
      sprintTurns,
      learnerText,
    );
    if (parsed === null) return;

    const { partnerTurn } = commitExchange(
      sessionId,
      null,
      {
        role: "partner",
        text: parsed.text,
        naturalPhrasing: null,
        markers: parsed.markers,
      },
      targetSprint,
    );

    emit({
      t: "done",
      learnerTurn: written,
      turn: partnerTurn,
      firstSentenceMs: firstSentenceMs ?? Date.now() - started,
      sprint: targetSprint,
      debrief: null,
      status: "active",
      fumbleDeckSize: fumbleDeck.length,
      fumbleDeck,
      words: committedWords(sessionId),
      fumbles: sessionFumbles,
    });
    void drilled;
  } catch (err) {
    if (clientSignal.aborted) return;
    if (sent > 0 && !shownSentence) emit({ t: "reset" });
    const reason =
      timeout.aborted && !clientSignal.aborted
        ? `The partner took longer than ${Math.round(modelTimeoutMs() / 1000)}s to answer.`
        : err instanceof ModelError
          ? err.message
          : err instanceof Error && err.name === "AbortError"
            ? "The model call was cut short."
            : "The model call failed.";
    emit({ t: "error", message: reason, retryable: err instanceof ModelError ? err.retryable : true });
  }
}

/**
 * A sentinel partner turn for the rare drill-response path that has no live
 * partner continuation to emit.
 *
 * The boundary code never issues a drill on the final sprint (there is
 * nothing to continue into), so this branch only fires when the session is
 * abandoned between the boundary and the drill response — a window of a
 * few seconds at most. The sentinel exists so the `done` event still has a
 * turn to carry, the client still has a status to render, and the wrap
 * panel still takes over from the composer on the next paint.
 */
function lastPartnerOfSprint(sprint: Sprint): Turn {
  return {
    id: -1,
    seq: -1,
    role: "partner",
    sprintId: sprint.id,
    text: "",
    naturalPhrasing: null,
    markers: [],
    kind: "normal",
    drillNatural: null,
    responseMs: null,
    createdAt: Date.now(),
  };
}
