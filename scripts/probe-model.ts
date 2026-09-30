import { buildSystemPrompt, type Moment } from "@/server/prompt";
import { streamChat } from "@/server/minimax";
import { splitReply, visibleProse } from "@/server/parse";
import { readStance, type Stance } from "@/server/stance";
import { IZAKAYA, TRAIN } from "@/server/scenarios";
import { firstSentenceEnd } from "@/lib/sentences";
import { readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * Fill in the settings this script needs from `.env.local`, and say so when the
 * environment disagrees with the file.
 *
 * Neither tsx nor Next overrides a variable that is already in the environment,
 * so a shell that happens to export `MINIMAX_API_KEY` — an agent runtime, a CI
 * image, a habit — silently wins over the file the repo documents. The result is
 * a 401 that looks like a stale key and is not. Filling only what is missing, and
 * warning about the conflict, keeps the script from quietly probing the wrong
 * thing while still letting a deliberate override work.
 */
function loadSettings() {
  const file = path.join(process.cwd(), ".env.local");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log(`no .env.local — using whatever is in the environment`);
    return;
  }

  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    const existing = process.env[key];
    if (existing === undefined) process.env[key] = value;
    else if (existing !== value) {
      console.log(
        `warning: ${key} is set in the environment and differs from .env.local — using the ` +
          `environment's. Unset it to probe with the file's value.`,
      );
    }
  }
}

loadSettings();

const IZAKAYA_OPENING = IZAKAYA.sprints[0]!;
const STATION = TRAIN.sprints[0]!;

/**
 * The exchange so far, so each stance is derived from real learner turns rather
 * than asserted by the probe. The turn being answered is added before the stance
 * is read, because that is the order `turn.ts` uses — a probe that derives the
 * stance one turn late measures the wrong instruction.
 */
const SAID: { role: "partner" | "learner"; text: string; naturalPhrasing: null; responseMs: number | null }[] = [];

/**
 * First attempts that came back with no Japanese prose at all.
 *
 * This is the number that decides how often the app pays for a second call: the
 * retry in `turn.ts` exists because this model sometimes writes only the quiet
 * correction and no line for the learner to read. A turn that hits it costs double
 * the latency and the money, so it is worth watching between prompt changes.
 */
let blank = 0;
let calls = 0;
let closingsAsking = 0;
let closingCount = 0;
const firstSentences: number[] = [];

function saidUpTo(learner: string | null) {
  if (learner === null) return SAID;
  return [...SAID, { role: "learner" as const, text: learner, naturalPhrasing: null, responseMs: 12_000 }];
}

async function ask(brief: typeof IZAKAYA_OPENING, moment: Moment, learner: string | null) {
  const stance: Stance = learner === null ? "plain" : readStance(saidUpTo(learner)).stance;
  const system = buildSystemPrompt({
    brief,
    moment,
    stance,
    earlier: [],
    deckWords: [],
    grammarPoint: null,
  });
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
  calls++;
  if (!prose.trim()) blank++;
  else firstSentences.push(first);

  if (moment === "closing") {
    closingCount++;
    if (/[?？]/.test(prose)) closingsAsking++;
    console.log(`  CLOSING ASKED A QUESTION: ${/[?？]/.test(prose)}`);
  }

  console.log(`  PROSE     : ${prose.trim() || "(no prose — the app would retry this)"}`);
  console.log(`  CORRECTION: ${JSON.stringify(correction)}`);
  console.log(`  METADATA  : ${metadata?.replace(/\n/g, " ⏎ ") ?? "(none)"}`);

  SAID.push({ role: "learner", text: learner ?? "", naturalPhrasing: null, responseMs: 12000 });
  SAID.push({ role: "partner", text: prose.trim(), naturalPhrasing: null, responseMs: null });
}

console.log(`model: ${process.env.MINIMAX_MODEL || "abab6.5s-chat"}`);

/**
 * Four cases that between them reach every stance, plus the two other moments.
 *
 * The stances are reached by what the learner writes, because that is how the app
 * reaches them: a long easy answer pairs with a long easy answer and the next
 * reply is `harder`, a garbled one is `slow`, and asking what a word is
 * `give-word`. A probe that forced the stance by argument would be measuring a
 * switch the product never uses.
 */
await ask(IZAKAYA_OPENING, "opening", null);
await ask(IZAKAYA_OPENING, "reply", "ビールを一つお願いします。");
await ask(IZAKAYA_OPENING, "reply", "焼き鳥を五本、タレは塩でお願いします。"); // -> harder
await ask(IZAKAYA_OPENING, "reply", "それ何て言うんですか。"); // -> give-word
await ask(IZAKAYA_OPENING, "closing", "締めを雑炊でお願いします。");

SAID.length = 0;
await ask(STATION, "opening", null);
await ask(STATION, "reply", "すみません、分からなくて。"); // -> slow

const sorted = [...firstSentences].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
console.log(
  `\n${calls} calls, ${blank} with no prose (${Math.round((blank / calls) * 100)}% would retry)`,
);
console.log(
  `closings that ended on a question: ${closingsAsking}/${closingCount}`,
);
console.log(
  `first sentence: median ${median.toFixed(0)}ms, min ${sorted[0]?.toFixed(0) ?? "-"}ms, ` +
    `max ${sorted[sorted.length - 1]?.toFixed(0) ?? "-"}ms, budget 900ms`,
);
