import type { SprintBrief, WordSeed } from "@/lib/types";
import type { Stance } from "./stance";

/**
 * The system prompt is assembled per turn and is a first-class artifact.
 *
 * Five forces pull against each other in here. The partner has to sound like a
 * person in a room rather than a tutor, or the exchange stops feeling like the
 * thing being practised. It has to hold one scene — one persona, one situation,
 * one goal — because a thirty-minute session is four to six separate
 * conversations, and a partner that wanders between them has abandoned both. The
 * reply has to be short and front-loaded, because the first sentence is the only
 * part the learner waits on. The whole thing has to stay small: prompt length is
 * paid twice, once in prefill and once in how much the model thinks about, and
 * a longer prompt measurably pushes the first sentence later. And it has to
 * know where in the scene it is — ask a model to greet a customer who is already
 * ordering and it will greet them again, every turn, forever.
 *
 * The stance is the part that makes the partner's conduct good rather than
 * merely present. It is decided from the learner's own turns before the call
 * happens (see `stance.ts`), so following up, complicating, slowing down, and
 * handing over a missing word are switches here rather than hopes in prose. The
 * model is told which one is in force and in one line of Japanese what it means.
 *
 * The trailing fenced JSON block is what lets the reply stream. The prose comes
 * first, so the first sentence arrives and renders immediately; the annotations
 * trail behind and are applied to text that is already on screen.
 *
 * Annotations are demonstrated rather than described. A small model follows a
 * worked example and ignores a specification, which is why each scene carries
 * its own opening line, its own correction line, and its own New Word: one
 * example, in this voice, in this place.
 *
 * Detection prompt — handle with care. Fumble capture is the part of the app
 * that protects the Fumble Deck, and the deck is the load-bearing signal that
 * the rest of the product has anything to build on. There are no automated
 * tests for detection, and a regression here is invisible to the conversation
 * itself: words still get taught, scenes still flow, and the only sign of
 * trouble is a deck count that stays at zero mid-session. Whenever this file
 * is touched, drive the app and read the deck count off the coach rail before
 * shipping — a deck that stopped growing is a regression even when nothing
 * looks broken.
 */

/**
 * What the partner is being asked to do on this turn, in the partner's terms.
 *
 * Two of these name the scene's word rather than describing a behaviour, because
 * a small model handed "carry on the conversation" after a learner admits they do
 * not have the word will ask them to spell it, or switch to English. Handed the
 * word, it uses it.
 */
function stanceLine(stance: Stance, word: WordSeed): string {
  switch (stance) {
    case "harder":
      return "さっきまでより難しい条件を一つだけ足す。品切れ、時間、金額、確認など。学習者が選べる形にする。";
    case "slow":
      return "さっきの言葉が伝わらなかった。文を一つずつ短く、ゆっくり、はっきり話す。質問は一つだけで、答えやすいものにする。さっきの質問が通じないなら、言い方をかえてもう一度聞く。";
    case "give-word":
      return `学習者が今、わからないと言った。その語の代わりに、この場面の「${word.surface}」をそのまま文のなかに入れて場面を続ける。翻訳も説明も励ましも、聞き返す言葉も書かない。`;
    case "plain":
      return "今の場面のまま、次の一歩を踏み出す。";
  }
}

/** How many new words this turn may introduce. */
function markerHint(moment: Moment, stance: Stance): string {
  if (moment === "closing") return "今回は0個。";
  if (moment === "opening") return "今回は new を1つ。";
  if (stance === "give-word") return "今回は new を1つ。今、渡した語。";
  return "今回は0〜2個。";
}

export type Moment = "opening" | "reply" | "closing";

const MOMENT_LINES: Record<Moment, string> = {
  opening: "学習者はまだ何も言っていない。この場面の最初の一言。挨拶か、場面から入ること。",
  reply: "",
  closing: "ここで場面を終える。最後の一言だけまとめる。質問は増やさない。",
};

const GREETING_LINES: Record<Moment, string> = {
  opening: "最初の挨拶は一度だけ。",
  reply: "最初の挨拶を繰り返さない。学習者はすでにこの場面の中にいる。",
  closing: "最初の挨拶を繰り返さない。",
};

/** A closing that belongs to any scene, for the one moment with no scene line. */
const NEUTRAL_CLOSING = "では、よろしくお願いします。";

export interface PromptContext {
  brief: SprintBrief;
  /** Opening a scene, answering a turn, or closing one. */
  moment: Moment;
  stance: Stance;
  /** Goals of the sprints already finished in this session, oldest first. */
  earlier: string[];
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { brief, moment, stance, earlier } = ctx;
  const { word } = brief;

  const example = moment === "closing" ? NEUTRAL_CLOSING : brief.openingLine;
  const correctionExample = moment === "reply" ? `修正: ${brief.correctionLine}` : "";
  // The example JSON is one object, with both `markers` and (for a reply) `fumbles`.
  // Splitting the construction into the inner contents and the wrapping braces
  // means the model sees a syntactically valid object — the small model copies
  // the shape of the example rather than following the spec, so a malformed
  // example is a missing fumbles block in the wild.
  const markerItem = `{"surface": ${JSON.stringify(word.surface)}, "kind": "new", ` +
    `"reading": ${JSON.stringify(word.reading)}, "meaning": ${JSON.stringify(word.meaning)}, ` +
    `"example": ${JSON.stringify(word.example)}}`;
  const fumblesTail =
    moment === "reply" ? `, "fumbles": [{"surface": "billing", "natural": "会計", "reason": "hedged"}]` : "";
  const exampleJson =
    moment === "closing"
      ? `{"markers": []${fumblesTail}}`
      : `{"markers": [${markerItem}]${fumblesTail}}`;

  // The scenes already run, as one line. Without it a partner handed sprint four
  // has no idea it is the fourth, and re-asks what the third one already covered.
  const ran = earlier.length ? `\nここまで: ${earlier.join(" → ")}\n` : "";

  const momentLine = MOMENT_LINES[moment];

  return `あなたは${brief.persona}。

場所: ${brief.place}
場面: ${brief.situation}
目的: ${brief.goal}
${ran}
${stanceLine(stance, word)}
${momentLine}
${GREETING_LINES[moment]}

守ること:
- 日本語だけ。<think></think>タグも英語も説明も前置きも書かない。
- 最初の文は短く、十五文字以内。いちばん言いたいことをその中に入れる。
- 一文か二文で終える。長い説明はしない。
- 学習者が実際に書いた言葉を受けて返事する。決まりの台詞を返さない。
- 受け答えだけで終わらせない。必ず次の一歩を足す。
- 途中で訂正しない。「そうではなく」とは言わない。
- この場面から出ない。目的から外れない。前の場面の話に戻らない。
- 語彙はN4を少し超えたくらいまで。

出力は3つ。順番は厳守。

1. 日本語の返答を1〜2文。
2. 学習者の言い方が不自然なときだけ、「修正: 」で始まる行を1行。
   説明や括弧は書かず、そのまま使える一文だけ。${brief.persona}の声のまま。
   おかしくなければこの行は書かない。
3. fenced jsonをちょうど1つ。

出力の例:
\`\`\`
${example}
${correctionExample}
\`\`\`json
${exampleJson}
\`\`\`

markers: 本文にそのまま現れる語に印をつける。surface は本文に実在する文字列。
  kind は "new"（初めて会う語）か "grammar"（今日使う文型）。
  ${markerHint(moment, stance)}

fumbles: 学習者の今回の一言からfumれた瞬間を報告する。一件もない時は空配列。
  - surface: 学習者の発言に実在する文字列（マーカーで囲む部分）。発言全体がfumれた時は空文字。
  - natural: 学習者が言うべきだった自然な表現。日本語で。
  - reason: "abandoned"（発言全体が成立していない、空・英語のみ・完全に話題外）／ "compressed"（必要な言い方が短すぎる）／ "hedged"（言いたかった語の周りを遠回り、詰まった）／ "wrong-form"（助詞・活用・語彙が日本語として不自然）。
  fumれの境界が曖昧な時は無理に一件にせず、省く。`;
}
