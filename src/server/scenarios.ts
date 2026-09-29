import type { Scenario, SprintBrief } from "@/lib/types";

/**
 * The scenario catalog. A Scenario is a family of scenes; a session runs four to
 * six of them in sequence, which is the shape the product is built around: real
 * life is a series of short conversations with different people, not one
 * continuous one.
 *
 * Every brief is one persona, one situation, one goal, written so the prompt can
 * use it verbatim. The persona is a person rather than a role, so the partner
 * sounds like somebody in a room. The goal is a thing that can be finished in
 * five to seven minutes of N4-level talk, so the sprint has somewhere to go.
 *
 * Three strings per scene exist only to be shown to the model, and they are the
 * difference between a prompt that describes the job and one that demonstrates
 * it — a small model follows a worked example and ignores a specification:
 *
 * - `opening` is what the partner's first line looks like in this voice. It
 *   always contains `word.surface`, so the single markers example in the prompt
 *   resolves against the text sitting directly above it.
 * - `correction` is what a quiet correction looks like here, so the model is
 *   never handed a line from a different scene.
 * - `word` is the New Word this scene exists to introduce, in the learner's
 *   terms: what it means, and one sentence using it.
 *
 * This is the only place scene content lives. Sprints hold a scene slug, not a
 * copy, so a brief can be reworded without rewriting anyone's history.
 */

export const IZAKAYA: Scenario = {
  slug: "izakaya",
  title: "居酒屋「灯」",
  blurb: "注文して、会計まで。一晩の居酒屋を五つの短い場面に分けたもの。",
  sprints: [
    {
      slug: "agari",
      persona: "居酒屋「灯」の店員（30歳の女性）",
      place: "東京の小さな居酒屋「灯」、入り口のカウンター",
      situation: "土曜の夜。一人の客が店に入ったところ。ここで注文を始める。",
      goal: "飲み物と肴を二品注文して、飲み物は何にするか決める",
      openingLine: "いらっしゃいませ。お通し、いただきますか。",
      correctionLine: "ビールを一本、お願いします。",
      word: {
        surface: "お通し",
        reading: "お通し",
        meaning: "店から最初に出る一品。注文していない肴。",
        example: "お通し、お願いします。",
      },
    },
    {
      slug: "tsukuri",
      persona: "焼き鳥を担当する店員（20歳の男性）",
      place: "同じ店。炭火のカウンター",
      situation: "最初の注文が決まったあとで。今度は焼き鳥の注文にきた。",
      goal: "焼き鳥を五本注文して、辛さとタレを決める",
      openingLine: "焼き鳥は五本です。タレはどうします。",
      correctionLine: "焼き鳥を五本、お願いします。",
      word: {
        surface: "タレ",
        reading: "たれ",
        meaning: "焼き鳥につけるソース。塩としょうゆの味がある。",
        example: "タレは塩で。",
      },
    },
    {
      slug: "ochi",
      persona: "居酒屋「灯」の店員（40歳の女性）",
      place: "同じ店。料理が運ばれてきた席",
      situation: "肴が二品運ばれてきたあと。もう少し何か食べたいと言っている。",
      goal: "肴をさらに一品追加して、量を調整する",
      openingLine: "もう一品、何になさいますか。",
      correctionLine: "追加で一品、お願いします。",
      word: {
        surface: "一品",
        reading: "いっぴん",
        meaning: "料理の一つ分。ひとつ分。",
        example: "もう一品、お願いします。",
      },
    },
    {
      slug: "shime",
      persona: "居酒屋「灯」の店員（30歳の女性）",
      place: "同じ店。食事の終わりに近い席",
      situation: "肴が落ち着いたころ。締めを注文するかどうかのころ。",
      goal: "締めを注文して、飲み物も最後の一杯にする",
      openingLine: "締めは雑炊とご飯、どちらになさいますか。",
      correctionLine: "締めを雑炊で、お願いします。",
      word: {
        surface: "雑炊",
        reading: "ぞうすい",
        meaning: "最後に食べる、汁とご飯を混ぜたもの。",
        example: "締めは雑炊で。",
      },
    },
    {
      slug: "seikyuu",
      persona: "居酒屋「灯」の店主（60歳の男性）",
      place: "同じ店。会計のカウンター",
      situation: "会計の紙が届いた。支払いを済ませるところ。",
      goal: "会計を済ませて、領収書を受け取る",
      openingLine: "お会計は五千八百円です。領収書をお願いします。",
      correctionLine: "カードでお支払いします。",
      word: {
        surface: "領収書",
        reading: "りょうしゅうしょ",
        meaning: "支払いの記録になる紙。",
        example: "領収書をお願いします。",
      },
    },
  ] satisfies SprintBrief[],
};

export const WORK: Scenario = {
  slug: "work",
  title: "職場 —— 4F の開発室",
  blurb: "仕事の日の一連。始業前の確認から残業の了承まで。",
  sprints: [
    {
      slug: "komae",
      persona: "同じチームの同僚（30歳の女性）",
      place: "始業前の、4F の開発室",
      situation: "出勤直後。今日は何をどの順番でやるかを確認する。",
      goal: "今日の作業の順番を確認して、最初の一件を始める",
      openingLine: "お疲れ様です。始業は九時ですよね。",
      correctionLine: "昨日の続きから始めます。",
      word: {
        surface: "始業",
        reading: "しぎょう",
        meaning: "仕事が始まる時刻。",
        example: "始業前に支度します。",
      },
    },
    {
      slug: "hokoku",
      persona: "開発部の部長（50歳の男性）",
      place: "部長室。短い打ち合わせ",
      situation: "昨日の作業が遅くなったので、部長に報告しに来る。",
      goal: "遅れた理由を説明して、立て直しかたの了承を得る",
      openingLine: "昨日の分は遅れませんか。",
      correctionLine: "遅れの原因を確認します。",
      word: {
        surface: "遅れ",
        reading: "おくれ",
        meaning: "予定より遅れること。",
        example: "遅れの原因を説明します。",
      },
    },
    {
      slug: "kaigi",
      persona: "開発部の課長（40歳の男性）",
      place: "会議室。資料を囲んでの会議の途中",
      situation: "会議で資料の修正点を話している。出番を待っている。",
      goal: "資料の修正点を一つ出して、それが通るまで話を進める",
      openingLine: "資料の修正点、ありますか。",
      correctionLine: "修正点は二つあります。",
      word: {
        surface: "修正点",
        reading: "しゅうせいてん",
        meaning: "直すべきところ。",
        example: "修正点を二つ出しました。",
      },
    },
    {
      slug: "denwa",
      persona: "同じチームの同僚（25歳の男性）",
      place: "自席。取引先から電話が鳴っている",
      situation: "取引先から電話。相手が用件と期限を話している。",
      goal: "電話の用件と期限を聞き取って、あとで部長に伝える",
      openingLine: "取引先から電話です。期限、何でしたっけ。",
      correctionLine: "用件と期限を聞きます。",
      word: {
        surface: "期限",
        reading: "きげん",
        meaning: "決まっている最後の日。",
        example: "期限は来週の金曜です。",
      },
    },
    {
      slug: "zangyo",
      persona: "開発部の課長（40歳の男性）",
      place: "夕方、残り人が減った開発室",
      situation: "今日は定時で帰れない。理由を説明する必要がある。",
      goal: "残業の理由と残り時間を伝えて、了承をもらう",
      openingLine: "今日は残業になりますか。",
      correctionLine: "残りの仕事を片づけて出ます。",
      word: {
        surface: "残業",
        reading: "ざんぎょう",
        meaning: "定時のあと残って仕事をすること。",
        example: "残業していいですか。",
      },
    },
  ] satisfies SprintBrief[],
};

export const TRAIN: Scenario = {
  slug: "train",
  title: "山手線 —— 遅延の一日",
  blurb: "止まる電車と、切符と、忘れ物。駅で人に頼む場面を五つ。",
  sprints: [
    {
      slug: "jiko",
      persona: "駅の係員（30歳の女性）",
      place: "山手線のホーム。運転を見合わせている",
      situation: "電車が止まっている。乗客がみんな駅員に質問している。",
      goal: "運転が再開する大体の時間と、遅れの長さを聞く",
      openingLine: "運転を見合わせています。ご不便をおかけします。",
      correctionLine: "運転再開の時間を教えてください。",
      word: {
        surface: "見合わせ",
        reading: "みあわせ",
        meaning: "一時的に動かさないこと。",
        example: "運転は11時に再開します。",
      },
    },
    {
      slug: "norikae",
      persona: "駅の係員（30歳の女性）",
      place: "駅の改札。券売機の前",
      situation: "乗り換えないと間に合わない時間。どのルートが速いか分からない。",
      goal: "乗り換えのルートと、必要な時間の目安を聞き出す",
      openingLine: "乗り換えのルート、一緒に探しましょう。",
      correctionLine: "乗り換えの時間を教えてください。",
      word: {
        surface: "乗り換え",
        reading: "のりかえ",
        meaning: "別の列車に乗り換えること。",
        example: "乗り換えて新宿に行きます。",
      },
    },
    {
      slug: "deguchi",
      persona: "ホームの係員（40歳の男性）",
      place: "乗り換えた後のホーム。目的地の駅が近い",
      situation: "目的地の駅に着いた。出口と、あと何歩で着くかが分からない。",
      goal: "出口の場所と、目的地までの所要時間を確かめる",
      openingLine: "出口は東口です。歩いて五分です。",
      correctionLine: "東口までは歩いて五分です。",
      word: {
        surface: "出口",
        reading: "でぐち",
        meaning: "駅の外に出る場所。",
        example: "出口はどこですか。",
      },
    },
    {
      slug: "teiki",
      persona: "駅の窓口の係員（25歳の男性）",
      place: "駅の窓口。定期券を買おうとしている",
      situation: "定期券の有効期限が分からない。どこまで使えるのかも曖昧だ。",
      goal: "定期券の有効期限と、使える区間を聞き出す",
      openingLine: "定期券ですね。どなたの分ですか。",
      correctionLine: "有効期限は今月末です。",
      word: {
        surface: "定期券",
        reading: "ていきけん",
        meaning: "毎日使う区間の前売り切符。",
        example: "定期券を一枚お願いします。",
      },
    },
    {
      slug: "nakimono",
      persona: "駅の遺失物係（50歳の女性）",
      place: "駅の窓口。定期券をなくしたあと",
      situation: "定期券をなくした。手続きと手数料が分からない。",
      goal: "落とし物の手続きと、手数料いくらになるのかを聞き出す",
      openingLine: "落とし物ですか。手数料は三百円です。",
      correctionLine: "手数料は三百円です。",
      word: {
        surface: "手数料",
        reading: "てちょう",
        meaning: "手続きにかかるお金。",
        example: "手数料を払いましょう。",
      },
    },
  ] satisfies SprintBrief[],
};

export const SCENARIOS: Scenario[] = [IZAKAYA, WORK, TRAIN];

/** The default when the learner does not pick: the first family. */
export const DEFAULT_SCENARIO = IZAKAYA;

export function listScenarios(): Scenario[] {
  return SCENARIOS;
}

export function getScenario(slug: string): Scenario | null {
  return SCENARIOS.find((s) => s.slug === slug) ?? null;
}

export function getBrief(family: Scenario, slug: string): SprintBrief | null {
  return family.sprints.find((s) => s.slug === slug) ?? null;
}
