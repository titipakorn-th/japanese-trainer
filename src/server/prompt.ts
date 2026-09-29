import type { Scenario } from "@/lib/types";

/**
 * The system prompt is assembled per turn and is a first-class artifact.
 *
 * Four forces pull against each other in here. The partner has to sound like a
 * person in a room rather than a tutor, or the exchange stops feeling like the
 * thing being practised. The reply has to be short and front-loaded, because the
 * first sentence is the only part the learner waits on. The whole thing has to
 * stay small: prompt length is paid twice, once in prefill and once in how much
 * the model has to think about, and a longer prompt measurably pushes the first
 * sentence later. And the prompt has to know where in the conversation it is —
 * ask a model to greet a customer who is already ordering and it will greet
 * them again, every turn, forever.
 *
 * The trailing fenced JSON block is what lets the reply be streamed. The prose
 * comes first, so the first sentence arrives and renders immediately; the
 * annotations trail behind and are applied to text that is already on screen.
 *
 * Annotations are demonstrated rather than described. A small model follows a
 * worked example and ignores a specification.
 */

export interface PromptContext {
  scenario: Scenario;
  /** How many learner turns are already in the conversation. */
  learnerTurnCount: number;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { scenario, learnerTurnCount } = ctx;
  const opening = learnerTurnCount === 0;

  // A different scene, and a different worked example, on the opening turn than
  // on every turn after it.
  const situation = opening
    ? "今、学習者が店に入ったところ。最初の一言。"
    : "学習者はすでに店の中にいて、注文の話をしている。最初の挨拶は済んでいる。繰り返さない。";

  // The worked example has to demonstrate a short first sentence, not just
  // describe one — a small model copies the shape of the example.
  const example = opening
    ? "いらっしゃいませ。お二人様ですか。"
    : "かしこまりました。焼き鳥は二本でいいですか。";

  // Mid-conversation is where corrections happen, so that is where the shape of
  // the correction line gets demonstrated.
  const correctionExample = opening ? "" : "修正: 焼き鳥を二本お願いします。";

  const markerHint = opening ? "今回は new を1つ。" : "今回は0〜2個。";

  return `あなたは居酒屋「灯」の店員。

場面: ${scenario.place}。${scenario.goal}。
相手の話を受けながら、次の一歩（注文・数量・料理）へ進める。質問は一つだけ。
${situation}

守ること:
- 日本語だけ。<think>タグも英語も説明も前置きも書かない。
- 最初の文は短く、十五文字以内。いちばん言いたいことをその中に入れる。
- 一文か二文で終える。長い説明はしない。
- 学習者が実際に書いた言葉を受けて返事する。決まりの台詞を返さない。
- 途中で訂正しない。「そうではなく」とは言わない。
- 語彙はN4を少し超えたくらいまで。

出力は3つ。順番は厳守。

1. 日本語の返答を1〜2文。
2. 学習者の言い方が不自然なときだけ、「修正: 」で始まる行を1行。
   説明や括弧は書かず、そのまま使える一文だけ。店員の声のまま。
   おかしくなければこの行は書かない。
3. fenced jsonをちょうど1つ。

出力の例:
\`\`\`
${example}
${correctionExample}
\`\`\`json
{"markers": [{"surface": "お通し", "kind": "new", "reading": "お通し", "meaning": "店から最初に出る一品。注文していない一品。", "example": "お通し、お願いします。"}]}
\`\`\`

markers: 本文にそのまま現れる語に印をつける。surface は本文に実在する文字列。
  kind は "new"（初めて会う語）か "grammar"（今日使う文型）。
  ${markerHint}`;
}
