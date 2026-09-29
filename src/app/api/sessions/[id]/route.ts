import { NextResponse } from "next/server";
import { getSessionState } from "@/server/sessions";

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
