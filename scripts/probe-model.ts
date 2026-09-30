import { buildSystemPrompt, type Moment } from "@/server/prompt";
import { streamChat } from "@/server/minimax";
import { splitReply, visibleProse } from "@/server/parse";
import { readStance, type Stance } from "@/server/stance";
import { IZAKAYA, TRAIN } from "@/server/scenarios";
import { firstSentenceEnd } from "@/lib/sentences";
import { performance } from "node:perf_hooks";

/**
 * Drive the production prompt against a real model and print what the latency
 * budget is actually being spent on.
 *
 * ADR 0001 was decided on numbers from this script, and those numbers are the
 * reason the model is an env var rather than a constant: re-run it when the
 * catalog changes. Sprints made the prompt longer, and prefill is paid on every
 * turn, so the first sentence is the thing to watch.
 */

const IZAKAYA_OPENING = IZAKAYA.sprints[0]!;
const STATION = TRAIN.sprints[0]!;

/** Turns the learner has already said, so the stance is derived rather than asserted. */
const SAID: { role: "partner" | "learner"; text: string; naturalPhrasing: null; responseMs: number | null }[] = [];

async function ask(brief: typeof IZAKAYA_OPENING, moment: Moment, learner: string | null) {
  const stance: Stance = learner === null ? "plain" : readStance(SAID).stance;
  const system = buildSystemPrompt({ brief, moment, stance, earlier: [], deckWords: [], grammarPoint: null });
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
  ];
  for (const turn of SAID) {
    messages.push(
      turn.role === "partner" ? { role: "assistant", content: turn.text } : { role: "user", content: turn.text },
    );
  }
  messages.push({ role: "user", content: learner ?? "（学習者が来た）" });

  const t0 = performance.now();
  let first = 0;
  const raw = await streamChat({
    messages,
    signal: AbortSignal.any([AbortSignal.timeout(20000)]),
    onDelta: (_c, acc) => {
      if (!first && firstSentenceEnd(visibleProse(acc)) > 0) first = performance.now() - t0;
    },
  });
  const { prose, correction, metadata } = splitReply(raw);

  console.log(`\n[${moment}/${stance}] ${brief.slug} — learner: ${learner ?? "(opening)"}`);
  console.log(
    `  prompt=${system.length} chars  first_sentence=${first.toFixed(0)}ms  total=${(performance.now() - t0).toFixed(0)}ms`,
  );
  console.log(`  PROSE     : ${prose.trim()}`);
  console.log(`  CORRECTION: ${JSON.stringify(correction)}`);
  console.log(`  METADATA  : ${metadata?.replace(/\n/g, " ⏎ ") ?? "(none)"}`);

  SAID.push({ role: "learner", text: learner ?? "", naturalPhrasing: null, responseMs: 12000 });
  SAID.push({ role: "partner", text: prose.trim(), naturalPhrasing: null, responseMs: null });
}

console.log(`model: ${process.env.MINIMAX_MODEL || "abab6.5s-chat"}`);

await ask(IZAKAYA_OPENING, "opening", null);
await ask(IZAKAYA_OPENING, "reply", "ビールを一つお願いします。");
await ask(IZAKAYA_OPENING, "reply", "それ何て言うんですか。");
await ask(IZAKAYA_OPENING, "reply", "はい");
await ask(IZAKAYA_OPENING, "closing", "生ビールを一つお願いします。");

SAID.length = 0;
await ask(STATION, "opening", null);
await ask(STATION, "reply", "いつ再開しますかね。");
