/**
 * Types shared by the server and the browser.
 *
 * A Session is one practice sitting. It is a sequence of Sprints, each one a
 * scene with a single persona, situation, and goal. A Sprint is a sequence of
 * Turns. The server owns all of it — the client renders a projection of this,
 * never the truth.
 */

export type MarkerKind = "new" | "fumble" | "grammar";

/**
 * An inline annotation pinned to a character range in a turn's text.
 *
 * `start`/`end` are resolved server-side against the final text, so a reloaded
 * session renders byte-identically to the live stream.
 */
export interface Marker {
  id: string;
  kind: MarkerKind;
  start: number;
  end: number;
  surface: string;
  reading: string;
  meaning: string;
  example: string;
}

export interface Turn {
  id: number;
  seq: number;
  role: "partner" | "learner";
  /** Which sprint this turn belongs to. Null only on pre-sprint sessions. */
  sprintId: string | null;
  /** Display text. The model's trailing metadata block is already stripped. */
  text: string;
  /** The natural phrasing of a learner turn, shown quietly beneath it. */
  naturalPhrasing: string | null;
  markers: Marker[];
  /**
   * Learner turns only: ms from the partner finishing its last line to the
   * learner submitting. The hesitation signal, and the reason it is measured in
   * the browser — the server cannot see when the text became readable.
   */
  responseMs: number | null;
  createdAt: number;
}

export type SessionStatus = "active" | "ended";

export interface Session {
  id: string;
  createdAt: number;
  endedAt: number | null;
  /** The scenario family this session was drawn from. */
  scenario: Scenario;
  status: SessionStatus;
}

/**
 * A word the scene is built around, and the line the partner opens the scene
 * with. The opening always contains the word, so the prompt's one worked example
 * can demonstrate a marker that resolves against the text in front of it.
 */
export interface WordSeed {
  surface: string;
  reading: string;
  meaning: string;
  example: string;
}

/**
 * One scene, briefable on its own. A Sprint is a SprintBrief that has been
 * entered: it has a clock, a turn count, and eventually a debrief.
 */
export interface SprintBrief {
  slug: string;
  /** Who the partner is, in the form the prompt can use verbatim. */
  persona: string;
  place: string;
  /** What is happening right now, before the learner says anything. */
  situation: string;
  /** The one thing this scene is for. The partner does not leave it. */
  goal: string;
  /** The partner's opening line, in this voice, in this place. */
  openingLine: string;
  /** A quiet correction that would make sense in this scene. */
  correctionLine: string;
  /** The New Word this scene introduces. */
  word: WordSeed;
}

/** A family of scenes. A session is a run of sprints drawn from one of these. */
export interface Scenario {
  slug: string;
  title: string;
  /** The picker's one-liner: what this is and when to pick it. */
  blurb: string;
  /** The scenes in this family, in order. A session runs four to six of them. */
  sprints: SprintBrief[];
}

/**
 * Why a sprint stopped. Shown in the debrief, and the only honest account of it.
 *
 * `migrated` is the one reason that is not a decision: it is how a session
 * recorded before sprints existed is given a sprint to hang its turns on.
 */
export type SprintEnding = "budget" | "sprint-clock" | "session-clock" | "abandoned" | "migrated";

/**
 * Why a particular moment counts as a fumble.
 *
 * The four cases mirror the spec: abandoned (no answer worth reading), compressed
 * (a required phrase said too short), hedged (circled the word), or wrong-form
 * (the form a native speaker would not use). The class is what the partner would
 * have said in the debrief; the model picks it, and a wrong pick is silently
 * preserved rather than re-classified, because re-classifying is a guess the
 * transcript cannot back up.
 */
export type FumbleReason = "abandoned" | "compressed" | "hedged" | "wrong-form";

/**
 * One stored moment of failure.
 *
 * `surface` is the substring of the learner's text the marker anchors to. For an
 * abandoned turn there is nothing to underline, so it is the empty string and no
 * inline marker is rendered; the moment is still on the deck. `natural` is the form
 * the learner was reaching for and is the deck key: the same `会計` covers a learner
 * who said `billing`, `bill`, or `チェック`.
 */
export interface Fumble {
  id: string;
  surface: string;
  natural: string;
  learnerSaid: string;
  situation: string;
  reason: FumbleReason;
  sessionId: string;
  sprintId: string | null;
  turnId: number | null;
  createdAt: number;
}

/**
 * One entry in the deck view: a natural form, how often it has been fumbled, and
 * when last. Worst offenders first, so effort goes where the learner is weakest.
 */
export interface FumbleDeckEntry {
  natural: string;
  count: number;
  lastSeenAt: number;
}

export interface Sprint {
  id: string;
  sessionId: string;
  /** 1-based position in the session. */
  seq: number;
  brief: SprintBrief;
  /**
   * `planned` is written when the session starts and nobody has entered the
   * scene yet. Distinguishing it from `active` is the difference between "the
   * partner is in this scene now" and "this scene is next", and a session whose
   * plan is a list of scenes needs to say which one is which.
   */
  status: "planned" | "active" | "closed";
  /** Learner turns the sprint runs before it closes on its own. */
  target: number;
  /** When the learner entered it. Null for a planned sprint nobody has opened. */
  startedAt: number | null;
  endedAt: number | null;
  endedBy: SprintEnding | null;
  debrief: Debrief | null;
}

/** One line of a debrief. Rendered as written, in order. */
export interface DebriefLine {
  kind: "pace" | "words" | "corrections" | "note";
  text: string;
}

/**
 * What happened in a sprint, built from the turns that were actually committed.
 *
 * Nothing here is the model's opinion of the learner: it is the transcript and
 * the measurements of the transcript. Fumble capture is its own slice, so the
 * deck is not in it yet.
 */
export interface Debrief {
  sprintId: string;
  /** Render the card immediately after the turn with this `seq`. */
  afterSeq: number;
  seq: number;
  title: string;
  place: string;
  goal: string;
  startedAt: number;
  endedAt: number;
  endedBy: SprintEnding;
  turnCount: number;
  /** Mean learner response time over the sprint, if it was measured at all. */
  avgResponseMs: number | null;
  /** Distinct New Words the partner introduced in this sprint. */
  words: Pick<Marker, "surface" | "reading" | "meaning">[];
  /** Each quiet correction the partner gave, with what it replaced. */
  corrections: { said: string; natural: string }[];
  /** Every fumble the model caught during this sprint, with the situation it happened in. */
  fumbles: Fumble[];
  lines: DebriefLine[];
}

export interface SessionState {
  session: Session;
  turns: Turn[];
  sprints: Sprint[];
  /** The live sprint, or null once the session has ended, or never began. */
  activeSprint: Sprint | null;
  /** The walls the app is holding itself to, so the client can show them. */
  pacing: Pacing;
  /** The deck as it stood when this snapshot was taken, worst offenders first. */
  fumbleDeck: FumbleDeckEntry[];
  /** Distinct natural forms the learner has fumbled so far. The "deck count". */
  fumbleDeckSize: number;
}

/** The turn budgets and clocks a session runs on. See `pacing.ts`. */
export interface Pacing {
  /** Learner turns per sprint before it closes on its own. */
  sprintTurns: number;
  /** ms a sprint may run before it closes on its own. */
  sprintMs: number;
  /** ms a whole session may run before it ends on its own. */
  sessionMs: number;
}

/** One committed exchange, as the client needs it to redraw itself. */
export interface Committed {
  learnerTurn: Turn | null;
  turn: Turn;
  sprint: Sprint;
  /** Set only on the exchange that closed the sprint. */
  debrief: Debrief | null;
  status: SessionStatus;
  /**
   * Distinct natural forms on the Fumble Deck after this commit. The rail
   * shows it during the session, and the size grows whenever a fumble lands
   * in a new word. A reload mid-session reads the same number from the
   * server, so a learner who picks up where they left off sees what they
   * actually earned.
   */
  fumbleDeckSize: number;
}

/** Frames sent over the turn stream, in order. */
export type TurnEvent =
  /** A slice of the partner's reply, already stripped of the metadata fence. */
  | { t: "delta"; v: string }
  /** A first attempt streamed something unusable; drop it and take the retry. */
  | { t: "reset" }
  /**
   * Something is committed, and here is the state to render after it.
   *
   * A request can produce more than one of these: crossing a sprint boundary
   * commits the closing exchange, then the next sprint's opening, and the debrief
   * belongs between them.
   */
  | { t: "done"; turn: Turn; learnerTurn: Turn | null; firstSentenceMs: number } & Committed
  /** The turn failed. Nothing was written; the conversation did not advance. */
  | { t: "error"; message: string; retryable: boolean };
