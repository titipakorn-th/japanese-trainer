import { buildSystemPrompt } from "@/server/prompt";
import { streamChat } from "@/server/minimax";
import { splitReply, visibleProse } from "@/server/parse";
import { firstSentenceEnd } from "@/lib/sentences";
import { performance } from "node:perf_hooks";

const scenario = {
  slug: "izakaya",
  title: "居酒屋「灯」",
  place: "東京の小さな居酒屋「灯」",
  goal: "飲み物と肴を注文して、会計まで通す",
};

// A conversation already in progress, so the prompt is the mid-conversation one.
const history: { role: "user" | "assistant"; content: string }[] = [
  { role: "assistant", content: "いらっしゃいませ。お一人様ですか。" },
];

async function ask(learner: string) {
  const system = buildSystemPrompt({ scenario, learnerTurnCount: 1 });
  const messages = [
    { role: "system" as const, content: system },
    ...history,
    { role: "user" as const, content: learner },
  ];
  const t0 = performance.now();
  let first = 0;
  const raw = await streamChat({
    messages,
    signal: AbortSignal.any([AbortSignal.timeout(20000)]),
    onDelta: (_c, acc) => {
      if (!first && firstSentenceEnd(visibleProse(acc)) > 0) {
        first = performance.now() - t0;
      }
    },
  });
  const { prose, correction, metadata } = splitReply(raw);
  console.log(`\nlearner: ${learner}`);
  console.log(`  first_sentence=${first.toFixed(0)}ms  total=${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`  RAW      : ${raw.replace(/\n/g, " ⏎ ")}`);
  console.log(`  PROSE    : ${prose.trim()}`);
  console.log(`  CORRECTION: ${JSON.stringify(correction)}`);
  console.log(`  METADATA : ${metadata?.replace(/\n/g, " ⏎ ") ?? "(none)"}`);
}

for (const line of ["ビールいる", "you are going して billing です", "かsongた"]) {
  await ask(line);
}
