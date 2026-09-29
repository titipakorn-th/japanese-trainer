import { NextResponse } from "next/server";
import { createSession, IZAKAYA } from "@/server/sessions";

/** The learner starts a session from the URL. This opens the server-side record. */
export async function POST() {
  const session = createSession(IZAKAYA);
  return NextResponse.json({ id: session.id }, { status: 201 });
}
