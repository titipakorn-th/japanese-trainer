import { buildSystemPrompt, type Moment } from "@/server/prompt";
import { streamChat } from "@/server/minimax";
import { splitReply, visibleProse } from "@/server/parse";
import { readStance, type Stance } from "@/server/stance";
import { IZAKAYA, TRAIN } from "@/server/scenarios";
import { firstSentenceEnd } from "@/lib/sentences";
import { FIRST_SENTENCE_BUDGET_MS } from "@/lib/measure";
import { loadSettings } from "./settings";
import { looksJapanese } from "@/lib/reply";
import { performance } from "node:perf_hooks";

loadSettings();

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
const TICKET = TRAIN.sprints[3]!;

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

/** Enough to say something about a rate. One closing is an anecdote. */
const CLOSING_SAMPLES = 3;

/**
 * A brisk but unremarkable answer time, so the `harder` stance — which needs two
 * quick, uncorrected answers before it fires — is reachable from what a learner
 * actually writes rather than from a number chosen to trip it.
 */
const BRISK_MS = 12_000;

function saidUpTo(learner: string | null) {
  if (learner === null) return SAID;
  return [
    ...SAID,
    { role: "learner" as const, text: learner, naturalPhrasing: null, responseMs: BRISK_MS },
  ];
}

async function ask(brief: typeof IZAKAYA_OPENING, moment: Moment, learner: string | null) {
  // A closing is always `plain` in the app — a scene ending is not a moment to
  // complicate or rescue — so deriving a stance here would measure a switch the
  // product never uses, and print it as if it had.
  const stance: Stance =
    moment === "closing" || learner === null ? "plain" : readStance(saidUpTo(learner)).stance;
  const system = buildSystemPrompt({
    brief,
    moment,
    stance,
    earlier: [],
    deckWords: [],
    grammarPoint: null,
    // The probe measures latency and the streaming shape, so the New Word
    // machinery is stubbed rather than simulated: a probe with a fake word
    // history in it would be measuring a prompt the app never sends.
    metWords: [],
    allowance: { thisSprint: 3, thisTurn: 1 },
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
  // The same test the app uses to decide whether to retry, so this rate is the
  // rate the app experiences rather than a stricter one.
  if (!looksJapanese(prose)) blank++;
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
 * Four exchanges that between them reach every stance, plus all three moments.
 *
 * The stances are reached by what the learner writes, because that is how the app
 * reaches them: a long easy answer pairs with a long easy answer and the next
 * reply is `harder`, a hesitant one is `slow`, and asking what a word is
 * `give-word`. A probe that forced the stance by argument would be measuring a
 * switch the product never uses.
 *
 * Three scenes, three closings. One closing is an anecdote, and the closing is the
 * moment this prompt had to fix, so it is the number that most needs a sample.
 */
await ask(IZAKAYA_OPENING, "opening", null);
await ask(IZAKAYA_OPENING, "reply", "ビールを一つお願いします。");
await ask(IZAKAYA_OPENING, "reply", "焼き鳥を五本、タレは塩でお願いします。"); // -> harder
await ask(IZAKAYA_OPENING, "reply", "それ何て言うんですか。"); // -> give-word
await ask(IZAKAYA_OPENING, "closing", "締めを雑炊でお願いします。");

SAID.length = 0;
await ask(STATION, "opening", null);
await ask(STATION, "reply", "すみません、分からなくて。"); // -> slow
await ask(STATION, "closing", "いつ再開するか、まだ分かりません。");

SAID.length = 0;
await ask(TICKET, "opening", null);
await ask(TICKET, "reply", "有効期限はいつまでですか。");
await ask(TICKET, "closing", "じゃ、それでお願いします。");

const sorted = [...firstSentences].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

console.log(`\n${calls} calls.`);
console.log(
  `replies the app would retry (no usable prose): ${blank}/${calls}` +
    (blank > 0 ? " — the prompt is losing the output contract again" : ""),
);
console.log(
  `closings that ended on a question: ${closingsAsking} of ${closingCount}` +
    (closingCount < CLOSING_SAMPLES ? " — too few to mean much" : ""),
);
console.log(
  `first sentence: median ${median.toFixed(0)}ms, min ${sorted[0]?.toFixed(0) ?? "-"}ms, ` +
    `max ${sorted[sorted.length - 1]?.toFixed(0) ?? "-"}ms, budget ${FIRST_SENTENCE_BUDGET_MS}ms`,
);
