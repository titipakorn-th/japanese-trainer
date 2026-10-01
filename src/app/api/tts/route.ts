import { speak, ttsTimeoutMs, TtsError } from "@/server/tts";

/**
 * Speak a line.
 *
 * Body: `{ text: string }`. Response: the MP3 bytes, `audio/mpeg`.
 *
 * There is no session id, and that is deliberate. The audio is a function of the
 * text and the voice settings, so scoping it to a session would couple speech to
 * a session's lifecycle for no gain — a line from a session that has ended would
 * refuse to play, and the route would inherit the 404-on-ended overload the
 * other session routes use. Nothing here can reach a turn (ADR 0007).
 *
 * Failure is a 502 with `{ error }`, because the caller is an `<audio>` element
 * that can only be told it failed, and the client is expected to say nothing and
 * carry on: a learner without audio still has the whole conversation.
 */
export async function POST(request: Request) {
  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (text.length === 0) {
    return Response.json({ error: "`text` must be a non-empty string." }, { status: 400 });
  }

  // The learner navigating away should not leave a call billing characters.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(ttsTimeoutMs())]);

  try {
    const result = await speak(text, signal);
    return new Response(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(result.audio.length),
        // The two `X-Speech-` headers are how you tell a cache hit from a paid
        // synthesis by hand — `curl -D -` against this route while watching
        // `.tts-cache/` fill. `X-Speech-Usage-Characters` is the cost the spec
        // asked to be measurable, reported from whatever the API last said.
        //
        // No `Cache-Control`: this is a POST, which browsers do not cache, and
        // the client's own small URL cache is what makes a replay instant.
        "X-Speech-Synthesized": result.synthesized ? "1" : "0",
        "X-Speech-Usage-Characters": String(result.usageCharacters),
      },
    });
  } catch (error) {
    if (error instanceof TtsError) {
      // 502: the caller's request was fine, the thing it asked for could not be
      // produced. 400 is wrong (the text is ours to speak), 500 is wrong (this is
      // an upstream dependency, not a bug in this app).
      return Response.json(
        { error: error.message, retryable: error.retryable },
        { status: error.retryable ? 503 : 502 },
      );
    }
    return Response.json({ error: "The line could not be spoken." }, { status: 502 });
  }
}
