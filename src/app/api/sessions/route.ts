import { NextResponse } from "next/server";
import { createSession } from "@/server/sessions";
import { DEFAULT_SCENARIO, getScenario } from "@/server/scenarios";

/**
 * The learner picks a scenario, then commits. The whole plan — which scenes, in
 * which order — is written here, before the first word is said, so the session
 * has a shape the learner can see coming and an interrupted session resumes into
 * the scene it was going to run.
 *
 * Body: `{ scenario: string }`, the slug from the picker. A slug the catalog does
 * not have falls back to the default rather than failing the start: the learner
 * asked for a session, and refusing over a bad link is a worse answer than
 * running a different scene.
 */
export async function POST(request: Request) {
  let slug = "";
  try {
    const body = (await request.json()) as { scenario?: unknown };
    slug = typeof body.scenario === "string" ? body.scenario : "";
  } catch {
    // No body is the same as no choice, and is the older call shape.
  }

  const session = createSession(getScenario(slug) ?? DEFAULT_SCENARIO);
  return NextResponse.json({ id: session.id }, { status: 201 });
}
