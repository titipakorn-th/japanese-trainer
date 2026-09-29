import { randomUUID } from "node:crypto";
import { db } from "./db";
import { DEFAULT_SCENARIO, getBrief, getScenario } from "./scenarios";
import { pacing, sprintsPerSession } from "./pacing";
import { buildDebrief } from "./debrief";
import type {
  Debrief,
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
  };
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

  db.transaction(() => {
    db.prepare("INSERT INTO session (id, created_at, scenario, status, ended_at) VALUES (?, ?, ?, 'active', NULL)").run(
      id,
      now,
      scenario.slug,
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

  return { id, createdAt: now, endedAt: null, scenario, status: "active" };
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
  return {
    session,
    turns: getTurns(id),
    sprints,
    activeSprint: getActiveSprint(id),
    pacing: pacing(),
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
}

const insertTurn = db.prepare(
  `INSERT INTO turn (session_id, seq, role, sprint_id, text, natural, markers, response_ms, created_at)
   VALUES (@sessionId, @seq, @role, @sprintId, @text, @natural, @markers, @responseMs, @createdAt)`,
);

function writeTurn(
  sessionId: string,
  seq: number,
  sprintId: string | null,
  t: NewTurn,
  createdAt: number,
  responseMs: number | null = null,
): Turn {
  const info = insertTurn.run({
    sessionId,
    seq,
    role: t.role,
    sprintId,
    text: t.text,
    natural: t.naturalPhrasing,
    markers: JSON.stringify(t.markers),
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
function openSprint(sessionId: string, seq: number, brief: SprintBrief, startedAt: number): Sprint {
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
  const spent = getTurns(sprint.sessionId).filter((t) => t.sprintId === sprint.id);
  const debrief = buildDebrief(sprint, spent, endedBy, now);
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
 * Commit a whole exchange, or nothing.
 *
 * A learner's turn and the partner's reply land in one transaction. The stream
 * only calls this after the model has finished cleanly, so a failed or timed-out
 * call cannot advance the conversation by half a turn.
 *
 * The quiet correction is stored on the *learner's* turn, not the partner's. It
 * is a rephrasing of what the learner said, and it belongs under what they said.
 */
export const commitExchange = db.transaction(
  (
    sessionId: string,
    learner: (NewTurn & { responseMs: number | null }) | null,
    partner: NewTurn,
    sprint: Sprint,
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
}

/**
 * Close a sprint and open the next one, all or nothing.
 *
 * This is the riskiest write in the app: it moves the session from one scene to
 * another, and a half-applied boundary would leave the learner in a scene the
 * debrief had already closed, or in a new one that never opened. So the closing
 * exchange, the debrief, the sprint rows, the session's status, and the next
 * scene's opening line all commit together or none of them do — which means both
 * model calls are made before any of it is written, and a failure in either one
 * costs the learner nothing and leaves the conversation where it was.
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
      openingTurn = writeTurn(
        sessionId,
        seq + (learnerTurn ? 2 : 1),
        nextSprint.id,
        boundary.opening,
        now,
      );
    } else {
      db.prepare("UPDATE session SET status = 'ended', ended_at = ? WHERE id = ?").run(now, sessionId);
      status = "ended";
    }

    return { debrief, learnerTurn, closingTurn, nextSprint, openingTurn, status };
  },
);

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
