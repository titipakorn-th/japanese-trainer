import type { GrammarPoint, SprintBrief, WordSeed } from "@/lib/types";
import type { Stance } from "./stance";

/**
 * The deck words currently on the Fumble Deck, as their natural forms.
 *
 * Each entry is a Japanese phrase the learner has fumbled before. The deck view
 * is the source — we read it fresh each turn so a word that just got cleared
 * stops being targeted on the next turn.
 */
export type DeckWord = string;

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
 * Detection prompts — handle with care. Fumble capture is the part of the app
 * that protects the Fumble Deck, and the deck is the load-bearing signal that
 * the rest of the product has anything to build on. There are no automated
 * tests for detection, and a regression here is invisible to the conversation
 * itself: words still get taught, scenes still flow, and the only sign of
 * trouble is a deck count that stays at zero mid-session. Whenever this file
 * is touched, drive the app and read the deck count off the coach rail before
 * shipping — a deck that stopped growing is a regression even when nothing
 * looks broken. The same care extends to deck clearance: a `produced` field
 * that stops being reported will not fail any conversation, but the deck will
 * silently stop shrinking and the learner will lose the only progress signal the
 * product shows them.
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
function markerHint(moment: Moment, stance: Stance, hasDeck: boolean): string {
  if (moment === "closing") return "今回は0個。";
  if (moment === "opening") {
    return hasDeck
      ? "今回は new を1つ、deck を1つまで。相手の語を本文に入れるなら deck のマーカーで囲む。"
      : "今回は new を1つ。";
  }
  if (stance === "give-word") return "今回は new を1つ。今、渡した語。";
  return hasDeck
    ? "今回は new を0〜1、deck を0〜1。deck の語を本文に入れるなら deck のマーカーで囲む。"
    : "今回は0〜2個。";
}

/** Whether the deck-word engineering instruction needs to appear this turn. */
function deckBlock(deckWords: DeckWord[]): string {
  if (deckWords.length === 0) return "";
  const lines = deckWords.map((w) => `- ${w}`).join("\n");
  return `
デッキ:
学習者がこの言葉を過去にfumった。学習者が自然にこれらのうち少なくとも一語を言うまで、場面を終わらせない。相手の返事や質問のなかに「言わないと次に進めない」状況を一つつくる。「言ってください」と教えるのではなく、状況のなかで必然にする。あなたの文のなかにその語を入れるときは、それを "deck" のマーカーで囲む。学習者がすでに言っていたら、それはクリアされたとして扱う。今日の場面ではクリアを狙う必要はない。
${lines}
`;
}

/**
 * The session's grammar point, told to the partner so they actually use it.
 *
 * The pattern matters most by being used: a learner who reads the rationale
 * but never hears the pattern in a different sentence frame has memorised a
 * sentence, not a pattern. The block names the pattern, says why it exists,
 * quotes one example, and tells the partner to spread three or four uses
 * across the session in different frames — exactly what makes the difference
 * between a memorised phrase and a usable one.
 */
function grammarBlock(point: GrammarPoint): string {
  return `
今日の文型: ${point.name}
なぜ: ${point.why}
一文で言えること: ${point.shortens}
例: ${point.example}

このセッション全体で三回から四回、別の文脈で使ってください。一回の発言に全部詰め込まないでください。文脈が変わるたびに違う文に入れてください。使ったときは markers の kind: "grammar" で本文のその語句に印をつけてください。
`;
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
  /**
   * Deck words this session is trying to put back into the learner's mouth.
   * Empty on a fresh deck. The partner is instructed to engineer a situation
   * that requires at least one of these — the distinction between "mention" and
   * "require" is what makes the deck worth anything.
   */
  deckWords: DeckWord[];
  /**
   * The one grammar pattern this session teaches. Null on a session recorded
   * before the grammar-point slice existed; a fresh session always carries
   * one. The block shown to the partner is the only way the model knows what
   * to use three or four times across the session.
   */
  grammarPoint: GrammarPoint | null;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { brief, moment, stance, earlier, deckWords, grammarPoint } = ctx;
  const { word } = brief;

  const example = moment === "closing" ? NEUTRAL_CLOSING : brief.openingLine;
  const correctionExample = moment === "reply" ? `修正: ${brief.correctionLine}` : "";
  const exampleDeck = deckWords[0];
  // The example JSON is one object, with both `markers` and (for a reply) `fumbles`.
  // Splitting the construction into the inner contents and the wrapping braces
  // means the model sees a syntactically valid object — the small model copies
  // the shape of the example rather than following the spec, so a malformed
  // example is a missing fumbles block in the wild.
  const markerItem = `{"surface": ${JSON.stringify(word.surface)}, "kind": "new", ` +
    `"reading": ${JSON.stringify(word.reading)}, "meaning": ${JSON.stringify(word.meaning)}, ` +
    `"example": ${JSON.stringify(word.example)}}`;
  // A deck marker in the example is built from the first deck word — its
  // surface is the natural form, and reading/meaning/example are read from the
  // fumble table at call time. The marker shape exists to demonstrate `kind:
  // "deck"` rather than to convey meaning; the partner already speaks Japanese.
  const deckMarkerItem = exampleDeck
    ? `{"surface": ${JSON.stringify(exampleDeck)}, "kind": "deck", "reading": "", "meaning": "", "example": ""}`
    : "";
  // The opening example carries a `new` marker; when there's a deck, also show a
  // `deck` marker so the model sees the right shape. For reply/closing, the
  // markers block is empty unless deck words happen to appear in this turn.
  const exampleMarkers =
    moment === "closing"
      ? "[]"
      : deckMarkerItem
        ? `[${markerItem}, ${deckMarkerItem}]`
        : `[${markerItem}]`;
  const fumblesTail =
    moment === "reply"
      ? `, "fumbles": [{"surface": "billing", "natural": "会計", "reason": "hedged"}]`
      : "";
  // A `produced` block is reported on reply turns only — the opening has no
  // learner text yet. The shape is `[{"natural": "..."}]`, where the natural is
  // one of the deck words above. The example shows the common case (empty).
  const producedTail =
    moment === "reply" && deckWords.length > 0
      ? `, "produced": [{"natural": ${JSON.stringify(exampleDeck)}}]`
      : "";
  // Drill appears in the example on reply turns only, mirroring when the model
  // would actually consider issuing one. The shape is `{"natural": "..."}`,
  // and a fumble whose natural matches is the most common trigger. A model
  // that copies the example on a turn with no drill would force one anyway,
  // so the example must keep drill optional and absent.
  const drillTail =
    moment === "reply"
      ? `, "drill": {"natural": "会計"}`
      : "";
  const exampleJson = `{"markers": ${exampleMarkers}${fumblesTail}${producedTail}${drillTail}}`;

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
${grammarPoint ? grammarBlock(grammarPoint) : ""}
${deckBlock(deckWords)}

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
  kind は "new"（初めて会う語）／ "grammar"（今日使う文型）／ "deck"（学習者が過去にfumったデッキの語）。
  "new" は今日の場面が初出の語。"deck" は学習者のデッキにある語で、 本文に出てきたら必ず deck で印をつける（"new"ではない）。
  "grammar" は今日の文型がそのまま表れている語句に印をつける。${grammarPoint ? `「${grammarPoint.name}」の形が使われたとき、その語句を surface にする。` : ""}
  ${markerHint(moment, stance, deckWords.length > 0)}

fumbles: 学習者の今回の一言からfumれた瞬間を報告する。一件もない時は空配列。
  - surface: 学習者の発言に実在する文字列（マーカーで囲む部分）。発言全体がfumれた時は空文字。
  - natural: 学習者が言うべきだった自然な表現。日本語で。
  - reason: "abandoned"（発言全体が成立していない、空・英語のみ・完全に話題外）／ "compressed"（必要な言い方が短すぎる）／ "hedged"（言いたかった語の周りを遠回り、詰まった）／ "wrong-form"（助詞・活用・語彙が日本語として不自然）。
  fumれの境界が曖昧な時は無理に一件にせず、省く。

produced: 学習者が今の発言のなかで自然に上記のデッキの語を言った場合、その natural を報告する。空配列でもよい。
  - natural: 上記のデッキの語そのもの。

drill: 学習者のfumれが深刻で、このまま流すと本当に抜け落ちる、と判断したときだけ。bar は高い。
  - 普通のfumれや小さな言い間違いでは drill しない。静かに直る経路で十分。
  - drill を使うと学習者は場面の外に一瞬出る。割り込みのコストに見合う一語だけ。
  - 1発話あたり最大1回。複数のfumれがあっても drill は一つだけ。
  - 形式: { "natural": "<日本語の自然な表現>" }。fumbles の natural と同じもの。
  - 一度 drill したら、同じ場面では再び drill しない（残りターンは普通の対応に戻す）。`;
}