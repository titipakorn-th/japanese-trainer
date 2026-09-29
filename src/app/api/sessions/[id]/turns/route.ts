import { getSession } from "@/server/sessions";
import { claimTurn, releaseTurn, runTurn } from "@/server/turn";
import type { TurnEvent } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

/**
 * Take a turn and stream the partner's reply.
 *
 * Body: `{ text: string | null, responseMs: number | null }`. `null` text asks for
 * the partner's opening line; a string is the learner's reply. `responseMs` is how
 * long the learner took to write it, measured in the browser, and is stored on
 * their turn. One code path, so the opening and every turn after it behave
 * identically.
 *
 * A request can commit two turns: crossing a sprint boundary closes the scene and
 * opens the next one, which the stream shows as two `done` frames with the
 * debrief on the first. So the client cannot assume one exchange per request.
 *
 * The response is newline-delimited JSON, not SSE: there is no event id or
 * reconnect semantics to buy here, and one fewer parser on the client.
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  if (!getSession(id)) {
    return Response.json({ error: "This session does not exist." }, { status: 404 });
  }
  let learnerText: string | null;
  let responseMs: number | null;
  try {
    const body = (await request.json()) as { text?: unknown; responseMs?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    learnerText = body.text === null ? null : text;
    responseMs = typeof body.responseMs === "number" ? body.responseMs : null;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (learnerText !== null && learnerText.length === 0) {
    return Response.json({ error: "Write something first." }, { status: 400 });
  }

  if (!claimTurn(id)) {
    return Response.json({ error: "A turn is already in flight." }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const clientSignal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TurnEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        await runTurn(id, { text: learnerText, responseMs }, send, clientSignal);
      } finally {
        releaseTurn(id);
        if (clientSignal.aborted) return;
        try {
          controller.close();
        } catch {
          // Already closed by a client that hung up mid-turn.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
