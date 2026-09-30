import { NextResponse } from "next/server";
import { setSessionFurigana } from "@/server/sessions";

type Context = { params: Promise<{ id: string }> };

/**
 * Toggle furigana on or off for one session.
 *
 * Body: `{ on: boolean }`. Returns `{ furiganaOn: boolean }`. A session that has
 * ended or does not exist returns 404 — the toggle is a live-session concern
 * and is not persisted for sessions the learner can no longer see.
 */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;

  let on: unknown;
  try {
    const body = (await request.json()) as { on?: unknown };
    on = body.on;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof on !== "boolean") {
    return NextResponse.json({ error: "`on` must be a boolean." }, { status: 400 });
  }

  const result = setSessionFurigana(id, on);
  if (result.kind === "missing") {
    return NextResponse.json({ error: "This session does not exist." }, { status: 404 });
  }
  if (result.kind === "ended") {
    return NextResponse.json({ error: "This session has ended." }, { status: 404 });
  }
  return NextResponse.json(result.value);
}