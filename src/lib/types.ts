/**
 * Types shared by the server and the browser.
 *
 * A Session is one practice sitting. A Turn is one exchange within it: the
 * partner speaks, the learner replies. The server owns both — the client renders
 * a projection of this, never the truth.
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
  /** Display text. The model's trailing metadata block is already stripped. */
  text: string;
  /** The natural phrasing of a learner turn, shown quietly beneath it. */
  naturalPhrasing: string | null;
  markers: Marker[];
  createdAt: number;
}

export interface Session {
  id: string;
  createdAt: number;
  scenario: Scenario;
  status: "active" | "ended";
}

export interface Scenario {
  slug: string;
  title: string;
  place: string;
  goal: string;
}

export interface SessionState {
  session: Session;
  turns: Turn[];
}

/** Frames sent over the turn stream, in order. */
export type TurnEvent =
  /** A slice of the partner's reply, already stripped of the metadata fence. */
  | { t: "delta"; v: string }
  /** A first attempt streamed something unusable; drop it and take the retry. */
  | { t: "reset" }
  /** The turn is persisted. Everything before this is provisional. */
  | { t: "done"; turn: Turn; learnerTurn: Turn | null; firstSentenceMs: number }
  /** The turn failed. Nothing was written; the conversation did not advance. */
  | { t: "error"; message: string; retryable: boolean };
