import { randomUUID } from "node:crypto";
import { db } from "./db";
import { DEFAULT_SCENARIO, getBrief, getScenario } from "./scenarios";
import { pacing, sprintsPerSession } from "./pacing";
import { buildWordLedger } from "./words";
import { buildDebrief } from "./debrief";
import { getFumbleDeck, insertFumbles, markFumblesDrilledByNatural, type DetectedFumble } from "./fumbles";
import { getGrammarPoint, pickGrammarPoint } from "./grammarPoints";
import type {
  Debrief,
  GrammarPoint,
  Marker,
  Scenario,
  Session,
  SessionState,
  SessionStatus,
  Sprint,
  SprintBrief,
  SprintEnding,
  Turn,
} from "@/lib/types";

/**
 * A session is a plan of sprints, and the plan is written at the start rather
 * than invented as it goes. A thirty-minute session is a sequence of scenes the
 * learner can see coming, which is the point of sprinting: the feedback lands
 * inside seven minutes instead of at the end of half an hour.
 */

const ENDINGS: ReadonlySet<string> = new Set<SprintEnding>([
  "budget",
  "sprint-clock",
  "session-clock",
  "abandoned",
  "migrated",
]);

interface SessionRow {
  id: string;
  created_at: number;
  scenario: string;
  status: string;
  ended_at: number | null;
  furigana_on: number | null;
  grammar_point_slug: string | null;
}

interface SprintRow {
  id: string;
  session_id: string;
  seq: number;
  sprint_slug: string;
  status: string;
  turn_target: number;
  started_at: number;
  ended_at: number | null;
  ended_by: string | null;
  debrief: string | null;
}

interface TurnRow {
  id: number;
  seq: number;
  role: string;
  sprint_id: string | null;
  text: string;
  natural: string | null;
  markers: string;
  drill_natural: string | null;
  response_ms: number | null;
  created_at: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    scenario: getScenario(row.scenario) ?? DEFAULT_SCENARIO,
    status: row.status === "ended" ? "ended" : "active",
    furiganaOn: row.furigana_on === 1,
    grammarPoint: resolveGrammarPoint(row.grammar_point_slug),
  };
}

/**
 * Look up the grammar point stored on a session, or null when the column is
 * unset (a session recorded before the grammar-point slice existed) or the
 * slug no longer exists in the catalog (a removed entry). Both cases are the
 * same UI: the rail does not show a card, the prompt carries no instruction,
 * and the session still runs.
 */
function resolveGrammarPoint(slug: string | null): GrammarPoint | null {
  if (!slug) return null;
  return getGrammarPoint(slug);
}

/**
 * How often each grammar point has been used, across all sessions on this
 * device.
 *
 * The picker uses this to rotate across points rather than handing the same
 * one out twice in a row, so a learner who runs the izakaya family three
 * times in a row meets all three izakaya-fitting patterns instead of the same
 * one each time. Counts are read from the same session rows the rest of the
 * app reads, so the rotation survives a reload.
 */
function grammarPointUsage(): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT grammar_point_slug AS slug, COUNT(*) AS n
         FROM session
        WHERE grammar_point_slug IS NOT NULL
        GROUP BY grammar_point_slug`,
    )
    .all() as { slug: string; n: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.slug] = row.n;
  return out;
}

function toSprint(row: SprintRow, family: Scenario): Sprint | null {
  const brief = getBrief(family, row.sprint_slug) ?? family.sprints[0];
  if (!brief) return null;

  let debrief: Debrief | null = null;
  if (row.debrief) {
    try {
      debrief = JSON.parse(row.debrief) as Debrief;
    } catch {
      debrief = null;
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    brief,
    status: row.status === "closed" ? "closed" : row.status === "planned" ? "planned" : "active",
    target: row.turn_target,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedBy: ENDINGS.has(row.ended_by ?? "") ? (row.ended_by as SprintEnding) : null,
    debrief,
  };
}

function toTurn(row: TurnRow): Turn {
  let markers: Marker[] = [];
  try {
    markers = JSON.parse(row.markers) as Marker[];
  } catch {
    markers = [];
  }
  return {
    id: row.id,
    seq: row.seq,
    role: row.role === "learner" ? "learner" : "partner",
    sprintId: row.sprint_id,
    text: row.text,
    naturalPhrasing: row.natural,
    markers,
    // `drill_natural` is set only on the partner turn that issued the drill —
    // every other row is a normal turn.
    kind: row.drill_natural ? "drill" : "normal",
    drillNatural: row.drill_natural,
    responseMs: row.response_ms,
    createdAt: row.created_at,
  };
}

/**
 * The scenes this session will run, in order.
 *
 * The family is a small ring, and sessions walk it rather than restarting it: a
 * learner who finished the izakaya family yesterday starts tonight's session at
 * the next scene along. Counting closed first-sprints is what makes that work —
 * the count is the number of sessions the learner has actually finished, and
 * five sprints of one session must not rotate the ring five times.
 */
function planSprints(scenario: Scenario): SprintBrief[] {
  const want = sprintsPerSession(scenario.sprints.length);
  const count = scenario.sprints.length;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sprint WHERE seq = 1 AND status = 'closed'`)
    .get() as { n: number };
  const first = count ? row.n % count : 0;

  const out: SprintBrief[] = [];
  for (let i = 0; i < want; i++) {
    const scene = scenario.sprints[(first + i) % count];
    if (scene) out.push(scene);
  }
  return out;
}

export function createSession(scenario: Scenario = DEFAULT_SCENARIO): Session {
  const id = randomUUID();
  const now = Date.now();
  const plan = planSprints(scenario);
  const target = pacing().sprintTurns;
  // The grammar point is picked outside the transaction so the picker can read
  // past usage without taking a write lock. It writes to the row in the same
  // transaction as the rest of the plan, so the slug and the plan commit
  // together — a half-written session would be one without a grammar point.
  const grammarPoint = pickGrammarPoint(scenario, grammarPointUsage());

  db.transaction(() => {
    db.prepare("INSERT INTO session (id, created_at, scenario, status, ended_at, furigana_on, grammar_point_slug) VALUES (?, ?, ?, 'active', NULL, 0, ?)").run(
      id,
      now,
      scenario.slug,
      grammarPoint.slug,
    );
    const first = plan[0] ?? scenario.sprints[0];
    // The first scene is live, but it has not *started* — the record exists before
    // the learner has seen the partner say anything, and a clock that started
    // here would expire a session someone opened and left for twenty minutes.
    if (first) insertSprint(id, 1, first, target, null, "active");
    // The rest of the plan is written up front so the session has a shape before
    // the learner has said anything, and so an interrupted session resumes into
    // the scene it was going to run rather than re-picking.
    for (let i = 1; i < plan.length; i++) {
      const scene = plan[i];
      if (scene) insertSprint(id, i + 1, scene, target, null, "planned");
    }
  })();

  return {
    id,
    createdAt: now,
    endedAt: null,
    scenario,
    status: "active",
    furiganaOn: false,
    grammarPoint,
  };
}

export function getSession(id: string): Session | null {
  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function getSprints(sessionId: string): Sprint[] {
  const session = getSession(sessionId);
  if (!session) return [];
  const rows = db
    .prepare("SELECT * FROM sprint WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as SprintRow[];
  return rows.map((row) => toSprint(row, session.scenario)).filter((s): s is Sprint => s !== null);
}

/**
 * The live sprint, or null when the session is over.
 *
 * Exactly one sprint is active at a time. The rest of the plan is `planned` and
 * becomes active when the one before it closes, so picking the last active row is
 * only a fallback for a store that somehow has two.
 */
export function getActiveSprint(sessionId: string): Sprint | null {
  const session = getSession(sessionId);
  if (!session || session.status === "ended") return null;
  const active = getSprints(sessionId).filter((s) => s.status === "active");
  return active[active.length - 1] ?? null;
}

export function getTurns(sessionId: string): Turn[] {
  const rows = db
    .prepare("SELECT * FROM turn WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as TurnRow[];
  return rows.map(toTurn);
}

export function getSessionState(id: string): SessionState | null {
  const session = getSession(id);
  if (!session) return null;
  const sprints = getSprints(id);
  // The deck is read fresh every snapshot. It is small, and reading it on every
  // page load is what makes the rail honest — a learner who reloads mid-session
  // sees the count they earned before the reload, not a stale zero.
  const fumbleDeck = getFumbleDeck();
  return {
    session,
    turns: getTurns(id),
    sprints,
    activeSprint: getActiveSprint(id),
    pacing: pacing(),
    fumbleDeck,
    fumbleDeckSize: fumbleDeck.length,
    // The New Word budget, on the same terms as the deck: rebuilt from the
    // committed turns so a reload shows the slots actually filled rather than
    // ten empty pips and a learner wondering whether the session lost its work.
    words: buildWordLedger(getTurns(id), sprints.length),
    furiganaOn: session.furiganaOn,
  };
}

export function nextSeq(sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), -1) AS max FROM turn WHERE session_id = ?")
    .get(sessionId) as { max: number };
  return row.max + 1;
}

export interface NewTurn {
  role: Turn["role"];
  text: string;
  naturalPhrasing: string | null;
  markers: Marker[];
  /**
   * Set on the partner turn that asks the learner to retry a phrase. Null for
   * every other turn — the default is the right default for ninety-nine percent
   * of the conversation, and the column is nullable so a row without a drill is
   * literally the absence of one.
   */
  drillNatural?: string | null;
}

const insertTurn = db.prepare(
  `INSERT INTO turn (session_id, seq, role, sprint_id, text, natural, markers, drill_natural, response_ms, created_at)
   VALUES (@sessionId, @seq, @role, @sprintId, @text, @natural, @markers, @drillNatural, @responseMs, @createdAt)`,
);

function writeTurn(
  sessionId: string,
  seq: number,
  sprintId: string | null,
  t: NewTurn,
  createdAt: number,
  responseMs: number | null = null,
): Turn {
  const drillNatural = t.drillNatural ?? null;
  const info = insertTurn.run({
    sessionId,
    seq,
    role: t.role,
    sprintId,
    text: t.text,
    natural: t.naturalPhrasing,
    markers: JSON.stringify(t.markers),
    drillNatural,
    responseMs,
    createdAt,
  });
  return {
    id: Number(info.lastInsertRowid),
    seq,
    role: t.role,
    sprintId,
    text: t.text,
    naturalPhrasing: t.naturalPhrasing,
    markers: t.markers,
    kind: drillNatural ? "drill" : "normal",
    drillNatural,
    responseMs,
    createdAt,
  };
}

function insertSprint(
  sessionId: string,
  seq: number,
  brief: SprintBrief,
  turnTarget: number,
  startedAt: number | null,
  status: Sprint["status"],
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sprint (id, session_id, seq, sprint_slug, status, turn_target, started_at, ended_at, ended_by, debrief)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, sessionId, seq, brief.slug, status, turnTarget, startedAt);
  return id;
}

/**
 * Enter the next scene of the plan.
 *
 * The plan was written when the session started, so this normally opens a row
 * that has been sitting there as `planned` since the first turn. Only a session
 * whose plan ran out gets a row inserted, and then only because there is
 * genuinely nothing to open.
 */
export function openSprint(sessionId: string, seq: number, brief: SprintBrief, startedAt: number): Sprint {
  const family = getSession(sessionId)?.scenario ?? DEFAULT_SCENARIO;
  const planned = db
    .prepare(`SELECT * FROM sprint WHERE session_id = ? AND seq = ?`)
    .get(sessionId, seq) as SprintRow | undefined;

  if (!planned) {
    const id = insertSprint(sessionId, seq, brief, pacing().sprintTurns, startedAt, "active");
    const row = db.prepare(`SELECT * FROM sprint WHERE id = ?`).get(id) as SprintRow;
    return toSprint(row, family) as Sprint;
  }

  db.prepare(`UPDATE sprint SET status = 'active', started_at = ? WHERE id = ?`).run(startedAt, planned.id);
  const row = db.prepare(`SELECT * FROM sprint WHERE id = ?`).get(planned.id) as SprintRow;
  return toSprint(row, family) as Sprint;
}

/**
 * Close a scene and record what happened in it, in one place.
 *
 * Both ways a session can lose a scene — running out of turns, or the learner
 * walking away — end here, so the debrief and the row that carries it cannot drift
 * apart between them.
 */
function closeSprint(sprint: Sprint, endedBy: SprintEnding, now: number): Debrief {
  const all = getTurns(sprint.sessionId);
  const spent = all.filter((t) => t.sprintId === sprint.id);
  // The ledger is built from the whole session rather than from this scene's turns,
  // so `seenAgain` is not scoped to the scene. It is still bounded by the moment:
  // the debrief is written at the boundary and stored, so a word needed again
  // three scenes later does not retroactively change what this card said. That is
  // deliberate — a debrief is a record of the sprint as it ended, and a card that
  // rewrote itself afterwards would be reporting something that had not happened
  // yet when the learner read it.
  const debrief = buildDebrief(
    sprint,
    spent,
    endedBy,
    now,
    buildWordLedger(all, getSprints(sprint.sessionId).length),
  );
  db.prepare(
    `UPDATE sprint SET status = 'closed', ended_at = ?, ended_by = ?, debrief = ? WHERE id = ?`,
  ).run(now, endedBy, JSON.stringify(debrief), sprint.id);
  return debrief;
}

/**
 * Mark a scene as entered, the first time a turn lands in it.
 *
 * A scene's clock starts when the partner says something in it, not when the row
 * was written. For every scene but the first that is the same moment, because the
 * row is written by `openSprint`; for the first it is the difference between a
 * session that has been created and a session that has begun.
 */
function touchSprintStart(sprintId: string | null, startedAt: number | null, now: number): void {
  if (!sprintId || startedAt !== null) return;
  db.prepare(`UPDATE sprint SET started_at = ? WHERE id = ? AND started_at IS NULL`).run(now, sprintId);
}

/**
 * The fumbles captured from this exchange, ready to land in the deck.
 *
 * Passed in only when there is a learner turn to attribute the moments to; the
 * deck gains rows in the same transaction as the turn, so a half-applied commit
 * cannot leave fumbles orphaned against a turn that was never written.
 */
export interface FumbleCapture {
  detected: DetectedFumble[];
  situation: string;
  learnerSaid: string;
}

/**
 * Commit a whole exchange, or nothing.
 *
 * A learner's turn and the partner's reply land in one transaction. The stream
 * only calls this after the model has finished cleanly, so a failed or timed-out
 * call cannot advance the conversation by half a turn.
 *
 * The quiet correction is stored on the *learner's* turn, not the partner's. It
 * is a rephrasing of what the learner said, and it belongs under what they said.
 *
 * Fumbles ride the same transaction: either both the turn and the deck row
 * commit, or neither does. A fumble the model reported but the DB did not write
 * would be invisible — and the deck is the only honest signal we have that
 * detection is alive, so it has to be kept honest.
 */
export const commitExchange = db.transaction(
  (
    sessionId: string,
    learner: (NewTurn & { responseMs: number | null }) | null,
    partner: NewTurn,
    sprint: Sprint,
    fumbles: FumbleCapture | null = null,
  ): { learnerTurn: Turn | null; partnerTurn: Turn } => {
    const sprintId = sprint.id;
    const now = Date.now();
    const seq = nextSeq(sessionId);
    touchSprintStart(sprint.id, sprint.startedAt, now);
    const learnerTurn = learner
      ? writeTurn(sessionId, seq, sprintId, learner, now, learner.responseMs)
      : null;
    const partnerTurn = writeTurn(
      sessionId,
      seq + (learner ? 1 : 0),
      sprintId,
      partner,
      now,
    );
    if (learnerTurn && fumbles && fumbles.detected.length > 0) {
      insertFumbles(
        sessionId,
        sprintId,
        learnerTurn.id,
        fumbles.learnerSaid,
        fumbles.situation,
        fumbles.detected,
      );
    }
    return { learnerTurn, partnerTurn };
  },
);

export interface Boundary {
  /** The learner's last turn in the sprint that is closing, if there was one. */
  learner: (NewTurn & { responseMs: number | null }) | null;
  /** The partner's closing line, in character, answering that turn. */
  closing: NewTurn;
  endedBy: SprintEnding;
  /** The next scene to open, or null when this is the last one. */
  next: SprintBrief | null;
  /** The next scene's opening line. Null when there is no next scene. */
  opening: NewTurn | null;
  /** Fumbles captured on the closing learner's turn, if there was one. */
  fumbles: FumbleCapture | null;
  /**
   * Optional drill partner turn to issue right after the closing line, on the
   * worst fumble of the sprint. Belongs to the closing sprint so the deck and
   * the debrief both see it as part of the scene it happened in. The drill
   * response lands later, in a separate turn call.
   */
  drill: { text: string; natural: string } | null;
}

/**
 * Close a sprint and open the next one, all or nothing.
 *
 * This is the riskiest write in the app: it moves the session from one scene to
 * another, and a half-applied boundary would leave the learner in a scene the
 * debrief had already closed, or in a new one that never opened. So the closing
 * exchange, the debrief, the sprint rows, the session's status, the optional
 * drill partner turn, and the next scene's opening line all commit together or
 * none of them do — which means both model calls are made before any of it is
 * written, and a failure in either one costs the learner nothing and leaves the
 * conversation where it was.
 */
export const commitBoundary = db.transaction(
  (
    sessionId: string,
    sprint: Sprint,
    boundary: Boundary,
  ): {
    debrief: Debrief;
    learnerTurn: Turn | null;
    closingTurn: Turn;
    drillTurn: Turn | null;
    nextSprint: Sprint | null;
    openingTurn: Turn | null;
    status: SessionStatus;
  } => {
    const now = Date.now();
    const seq = nextSeq(sessionId);
    touchSprintStart(sprint.id, sprint.startedAt, now);

    const learnerTurn = boundary.learner
      ? writeTurn(sessionId, seq, sprint.id, boundary.learner, now, boundary.learner.responseMs)
      : null;
    const closingTurn = writeTurn(
      sessionId,
      seq + (learnerTurn ? 1 : 0),
      sprint.id,
      boundary.closing,
      now,
    );
    // The drill partner turn, when present, lives between the closing line and
    // the next scene. It belongs to the closing sprint because the fumble it
    // retries is part of that scene; the drill response lands later, in a
    // separate turn, and also gets attributed to the closing sprint so a
    // re-render of the transcript stays consistent.
    const drillTurn = boundary.drill
      ? writeTurn(
          sessionId,
          seq + (learnerTurn ? 2 : 1),
          sprint.id,
          {
            role: "partner",
            text: boundary.drill.text,
            naturalPhrasing: null,
            markers: [],
            drillNatural: boundary.drill.natural,
          },
          now,
        )
      : null;
    if (learnerTurn && boundary.fumbles && boundary.fumbles.detected.length > 0) {
      insertFumbles(
        sessionId,
        sprint.id,
        learnerTurn.id,
        boundary.fumbles.learnerSaid,
        boundary.fumbles.situation,
        boundary.fumbles.detected,
      );
    }

    // The closing exchange belongs to the scene, so it is written before the scene
    // is closed and the debrief is built from what is now on disk rather than
    // from a list assembled alongside it.
    const debrief = closeSprint(sprint, boundary.endedBy, now);

    let nextSprint: Sprint | null = null;
    let openingTurn: Turn | null = null;
    let status: SessionStatus = "active";

    if (boundary.next && boundary.opening) {
      const nextSeqNumber = sprint.seq + 1;
      nextSprint = openSprint(sessionId, nextSeqNumber, boundary.next, now);
      // A drill partner turn shifts the opening line's seq number forward by
      // one. Without the +1 a drill would let two turns share a sequence
      // number, which the (session_id, seq) unique constraint would reject.
      openingTurn = writeTurn(
        sessionId,
        seq + (learnerTurn ? 2 : 1) + (drillTurn ? 1 : 0),
        nextSprint.id,
        boundary.opening,
        now,
      );
    } else {
      db.prepare("UPDATE session SET status = 'ended', ended_at = ? WHERE id = ?").run(now, sessionId);
      status = "ended";
    }

    return { debrief, learnerTurn, closingTurn, drillTurn, nextSprint, openingTurn, status };
  },
);

/**
 * The drill response — a learner turn that answers a drill partner turn.
 *
 * Returned separately from the rest of the turn machinery because a drill
 * response is the one place the server writes a learner turn without a partner
 * turn to follow it. The drill itself is in the closed sprint's transcript,
 * and the next call from `runTurn` will produce the partner continuation or
 * the next scene's opening.
 *
 * The success evaluation is a substring match on the normalised learner text:
 * a Japanese phrase contains itself, and the match has to be lenient enough
 * that punctuation and spaces do not turn a correct answer into a failure.
 * The deck cares about the natural form, not its exact surface.
 */
export function isDrillSuccess(learnerText: string, drillNatural: string): boolean {
  if (!drillNatural) return false;
  const norm = (s: string): string => s.replace(/[\s。、！？!?「」『』,.。]/g, "").toLowerCase();
  return norm(learnerText).includes(norm(drillNatural));
}

/**
 * Find the closed sprint that has a pending drill partner turn awaiting a
 * response.
 *
 * A pending drill is the most recent partner turn whose `kind` is `drill`. The
 * sprint it belongs to is whatever sprint row holds that turn. Returns null
 * when no pending drill exists, which is the common case and the only state
 * `runTurn` cares about for normal exchanges.
 */
export function findPendingDrillSprint(sessionId: string): Sprint | null {
  const row = db
    .prepare(
      `SELECT sprint_id FROM turn
        WHERE session_id = ? AND role = 'partner' AND drill_natural IS NOT NULL
        ORDER BY seq DESC, id DESC LIMIT 1`,
    )
    .get(sessionId) as { sprint_id: string | null } | undefined;
  if (!row || !row.sprint_id) return null;
  const sprint = db
    .prepare(`SELECT * FROM sprint WHERE id = ?`)
    .get(row.sprint_id) as SprintRow | undefined;
  if (!sprint) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  return toSprint(sprint, session.scenario);
}

/**
 * Commit a drill response learner turn and, on success, mark the matching
 * fumble as drilled.
 *
 * The drill response belongs to the sprint that holds the drill partner turn
 * (always a closed sprint). Marking the fumble is the entire point of the
 * retry — a success is a row update, a failure is silence, and the difference
 * shows up in the deck on the next reload.
 *
 * Returns the committed learner turn so the stream can emit a `done` frame
 * for it. The partner continuation lives in the caller's hands: this function
 * does not decide whether to keep the scene going or open the next one — the
 * caller knows which sprint the drill partner turn belonged to.
 */
export const commitDrillResponse = db.transaction(
  (
    sessionId: string,
    drillSprintId: string,
    text: string,
    responseMs: number | null,
  ): { learnerTurn: Turn; drilled: boolean } => {
    const now = Date.now();
    const seq = nextSeq(sessionId);
    const learnerTurn = writeTurn(
      sessionId,
      seq,
      drillSprintId,
      {
        role: "learner",
        text,
        naturalPhrasing: null,
        markers: [],
      },
      now,
      responseMs,
    );
    const drillRow = db
      .prepare(
        `SELECT drill_natural FROM turn
          WHERE session_id = ? AND role = 'partner' AND drill_natural IS NOT NULL
            AND sprint_id = ?
          ORDER BY seq DESC, id DESC LIMIT 1`,
      )
      .get(sessionId, drillSprintId) as { drill_natural: string } | undefined;
    let drilled = false;
    if (drillRow?.drill_natural && isDrillSuccess(text, drillRow.drill_natural)) {
      const changes = markFumblesDrilledByNatural(drillRow.drill_natural, drillSprintId);
      drilled = changes > 0;
    }
    return { learnerTurn, drilled };
  },
);

/**
 * Switch furigana on or off for one session.
 *
 * Furigana is a session-scoped display preference: the learner turns it on once
 * and it stays on for the rest of the session, including across reloads. A
 * session that has already ended cannot be flipped — the learner can no longer
 * see its transcript, so changing the preference is meaningless. Returns the
 * resulting flag, or null when the session does not exist or has ended.
 */
export function setSessionFurigana(sessionId: string, on: boolean): boolean | null {
  const session = getSession(sessionId);
  if (!session) return null;
  if (session.status === "ended") return null;
  db.prepare("UPDATE session SET furigana_on = ? WHERE id = ?").run(on ? 1 : 0, sessionId);
  return on;
}

/**
 * End a session where it stands, keeping everything in it.
 *
 * The learner's transcript, the sprints, and the debriefs are left exactly where
 * they are; only the status changes, so a bad ten minutes is still a session
 * that happened. An abandoned sprint is closed with a debrief like any other, so
 * the record says where the learner stopped instead of just stopping.
 */
export function abandonSession(sessionId: string, now = Date.now()): SessionState | null {
  const session = getSession(sessionId);
  if (!session) return null;
  if (session.status === "ended") return getSessionState(sessionId);

  db.transaction(() => {
    const active = getActiveSprint(sessionId);
    if (active) closeSprint(active, "abandoned", now);
    db.prepare("UPDATE session SET status = 'ended', ended_at = ? WHERE id = ?").run(now, sessionId);
  })();

  return getSessionState(sessionId);
}
