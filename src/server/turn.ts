import { buildSystemPrompt, type Moment, type PromptContext } from "./prompt";
import { ModelError, modelTimeoutMs, streamChat } from "./minimax";
import {
  parseReply,
  visibleProse,
  type ParsedFumble,
  type ParsedReply,
} from "./parse";
import { readStance, type Spoken, type Stance } from "./stance";
import { closeSprint, sessionExpired, pacing } from "./pacing";
import {
  commitBoundary,
  commitExchange,
  getActiveSprint,
  getSession,
  getSprints,
  getTurns,
  type NewTurn,
} from "./sessions";
import { insertFumbles, getFumbleDeckSize, type DetectedFumble } from "./fumbles";
import { fumbleMarkers } from "./fumbleMarkers";
import type { Marker, Sprint, SprintEnding, Turn, TurnEvent } from "@/lib/types";
import { firstSentenceEnd } from "@/lib/sentences";

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
  const japanese = chars.match(/[぀-ヿ一-鿿]/g)?.length ?? 0;
  return japanese / chars.length > JAPANESE_SHARE;
}

/** The next sprint in the plan, or null when this one was the last. */
function nextSprint(sprints: Sprint[], seq: number): Sprint["brief"] | null {
  return sprints.find((s) => s.seq === seq + 1)?.brief ?? null;
}

/** Goals of the scenes already run, so the partner knows where it is. */
function earlierGoals(sprints: Sprint[], before: number): string[] {
  return sprints
    .filter((s) => s.seq < before)
    .map((s) => s.brief.goal)
    .slice(-3);
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

  const sprint = getActiveSprint(sessionId);
  if (!sprint) {
    emit({ t: "error", message: "This session has no scene to play.", retryable: false });
    return;
  }

  const sprints = getSprints(sessionId);
  const learnerText = input.text;
  const responseMs = cleanResponseMs(input.responseMs);

  const allTurns = getTurns(sessionId);
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

      const parsed = await ask(
        {
          brief: sprint.brief,
          moment: (opening && learnerText === null ? "opening" : "reply") as Moment,
          stance,
          earlier: earlierGoals(sprints, sprint.seq),
        },
        inSprint,
        learnerText ?? "（学習者が来た）",
      );
      if (parsed === null) return;

      // The situation a fumble happened in is the partner's last line — what the
      // learner was responding to when they reached for the wrong word. Captured
      // here, not deeper inside `commitExchange`, because the closing call below
      // uses the same field and a single source is easier to keep honest.
      const lastPartner = [...inSprint].reverse().find((t) => t.role === "partner");
      const situation = lastPartner?.text ?? sprint.brief.goal;
      const capture =
        learnerText !== null && parsed.fumbles.length > 0
          ? { detected: parsed.fumbles, situation, learnerSaid: learnerText }
          : null;

      const { learnerTurn: written, partnerTurn } = commitExchange(
        sessionId,
        learnerText === null ? null : learnerTurn(learnerText, parsed.naturalPhrasing, parsed.fumbles),
        { role: "partner", text: parsed.text, naturalPhrasing: null, markers: parsed.markers },
        sprint,
        capture,
      );

      emit({
        t: "done",
        learnerTurn: written,
        turn: partnerTurn,
        firstSentenceMs: firstSentenceMs ?? Date.now() - started,
        sprint,
        debrief: null,
        status: "active",
        fumbleDeckSize: getFumbleDeckSize(),
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
      { brief: sprint.brief, moment: "closing", stance: "plain", earlier: earlierGoals(sprints, sprint.seq) },
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
    const lastPartner = [...history].reverse().find((t) => t.role === "partner");
    const closingSituation = lastPartner?.text ?? sprint.brief.goal;
    const fumbleCapture =
      learnerText !== null && closing.fumbles.length > 0
        ? { detected: closing.fumbles, situation: closingSituation, learnerSaid: learnerText }
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
    });

    const status = result.nextSprint ? "active" : "ended";
    const deckSize = getFumbleDeckSize();
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
      fumbleDeckSize: deckSize,
    });

    if (result.nextSprint && result.openingTurn) {
      emit({
        t: "done",
        learnerTurn: null,
        turn: result.openingTurn,
        firstSentenceMs: Date.now() - started,
        sprint: result.nextSprint,
        debrief: null,
        status,
        fumbleDeckSize: deckSize,
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
