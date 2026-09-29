import { NextResponse } from "next/server";
import { abandonSession, getSessionState } from "@/server/sessions";

type Context = { params: Promise<{ id: string }> };

/** Session state as the server holds it. A reload resumes from here. */
export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const state = getSessionState(id);
  if (!state) {
    return NextResponse.json({ error: "This session does not exist." }, { status: 404 });
  }
  return NextResponse.json(state);
}

/**
 * Abandon the session, keep everything in it.
 *
 * A bad ten minutes is still a session that happened, so the transcript, the
 * sprints, and the debriefs stay exactly where they are and only the status
 * changes. The active scene is closed with a debrief like any other, so the
 * record says where the learner stopped rather than just stopping.
 *
 * This is not a delete. Nothing in this app throws a learner's work away.
 */
export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  const state = abandonSession(id);
  if (!state) {
    return NextResponse.json({ error: "This session does not exist." }, { status: 404 });
  }
  return NextResponse.json(state);
}
