import { NextResponse } from "next/server";
import { addRevealedReading } from "@/server/sessions";

type Context = { params: Promise<{ id: string }> };

/**
 * Add a surface form to the session's revealed-readings set.
 *
 * Body: `{ surface: string }`. Returns `{ revealedReadings: string[] }` on
 * success — the full post-mutation set, so the client can replace its local
 * state without a second read. The surface must be a non-empty string;
 * empty / non-string bodies are 400. Missing or ended sessions are 404.
 */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;

  let surface: unknown;
  try {
    const body = (await request.json()) as { surface?: unknown };
    surface = body.surface;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof surface !== "string" || surface.length === 0) {
    return NextResponse.json({ error: "`surface` must be a non-empty string." }, { status: 400 });
  }

  const result = addRevealedReading(id, surface);
  if (result.kind === "missing") {
    return NextResponse.json({ error: "This session does not exist." }, { status: 404 });
  }
  if (result.kind === "ended") {
    return NextResponse.json({ error: "This session has ended." }, { status: 404 });
  }
  return NextResponse.json(result.value);
}