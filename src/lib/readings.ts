/**
 * The kanji reading dictionary.
 *
 * Each entry is a surface form with the reading that goes over it and a flag for
 * whether the learner is likely to be able to read it yet. The dictionary is the
 * source of the reading aid's behaviour: a word not in here renders as plain
 * text in every mode, because a ruby with no reading is just smaller text and a tap
 * target with no reading is a dead key.
 *
 * Two things make this safe to keep as a flat list:
 *
 * - The segmentation matches longest surface first, so a longer compound does
 *   not greedily mis-segment into shorter ones. `お願いします` is matched before
 *   `お願い`, and `大丈夫です` is matched before `大丈夫`. The order is built
 *   once, at module load.
 * - A word that is already written entirely in kana has no reading rendered at
 *   all, even when it is in the dictionary. Hiragana / katakana are their own
 *   reading; adding a ruby over `カウンター` is clutter, not help.
 *
 * The dictionary is hand-curated. Coverage should grow with the scenario
 * vocabulary — words the model is known to introduce belong here so the first
 * time the learner meets them, the dictionary is ready. A failure to render a
 * reading degrades to "render as plain text"; it never blocks the conversation.
 */

export interface Reading {
  /** The kana spelling that goes in the <rt>. */
  r: string;
  /**
   * The learner probably cannot read this unaided yet, so with the toggle off
   * the word renders as a tap-to-reveal target rather than as plain text.
   * Defaults to false; the only words flagged hard are the genuinely hard ones
   * the dictionary marks as such.
   */
  hard?: boolean;
}

/**
 * Surface-form dictionary. Add to it freely; new entries take effect the next
 * time the page reloads. Keep the words grouped by scenario family so the next
 * person editing it knows which scenes they came from.
 */
const RAW: Record<string, Reading> = {
  /* ----- greetings and set phrases ----- */
  いらっしゃいませ: { r: "いらっしゃいませ" },
  お願いします: { r: "おねがいします" },
  お願い: { r: "おねがい" },
  すみません: { r: "すみません" },
  大丈夫: { r: "だいじょうぶ", hard: true },

  /* ----- izakaya family ----- */
  お通し: { r: "おとおし" },
  飲み物: { r: "のみもの" },
  お飲み物: { r: "おのみもの" },
  注文: { r: "ちゅうもん", hard: true },
  肴: { r: "さかな", hard: true },
  二品: { r: "にひん", hard: true },
  決める: { r: "きめる", hard: true },
  焼き鳥: { r: "やきとり" },
  五本: { r: "ごほん" },
  タレ: { r: "たれ" },
  塩: { r: "しお" },
  醤油: { r: "しょうゆ" },
  味: { r: "あじ" },
  一品: { r: "いっぴん" },
  追加: { r: "ついか", hard: true },
  料理: { r: "りょうり" },
  量: { r: "りょう", hard: true },
  調整: { r: "ちょうせい", hard: true },
  締め: { r: "しめ" },
  雑炊: { r: "ぞうすい" },
  ご飯: { r: "ごはん" },
  一杯: { r: "いっぱい" },
  会計: { r: "かいけい", hard: true },
  円: { r: "えん" },
  領収書: { r: "りょうしゅうしょ" },
  支払い: { r: "しはらい", hard: true },
  支払: { r: "しはらい" },
  現金: { r: "げんきん", hard: true },
  カード: { r: "カード" },

  /* ----- work family ----- */
  始業: { r: "しぎょう" },
  九時: { r: "くじ" },
  昨日: { r: "きのう" },
  続き: { r: "つづき" },
  始めます: { r: "はじめます" },
  始める: { r: "はじめる", hard: true },
  残業: { r: "ざんぎょう" },
  定時: { r: "ていじ" },
  帰り: { r: "かえり", hard: true },
  残り: { r: "のこり" },
  残り時間: { r: "のこりじかん" },
  了承: { r: "りょうしょう", hard: true },
  遅れ: { r: "おくれ" },
  原因: { r: "げんいん", hard: true },
  報告: { r: "ほうこく", hard: true },
  説明: { r: "せつめい", hard: true },
  立て直し: { r: "たてなおし", hard: true },
  修正: { r: "しゅうせい", hard: true },
  修正点: { r: "しゅうせいてん" },
  資料: { r: "しりょう" },
  会議: { r: "かいぎ" },
  会議中: { r: "かいぎちゅう" },
  出番: { r: "でばん", hard: true },
  取引先: { r: "とりひきさき" },
  電話: { r: "でんわ" },
  用件: { r: "ようけん", hard: true },
  期限: { r: "きげん" },
  来週: { r: "らいしゅう" },
  金曜日: { r: "きんようび" },
  金曜: { r: "きんよう" },

  /* ----- train family ----- */
  運転: { r: "うんてん" },
  見合わせ: { r: "みあわせ" },
  再開: { r: "さいかい", hard: true },
  乘客: { r: "じょうきゃく", hard: true },
  駅員: { r: "えきいん" },
  質問: { r: "しつもん", hard: true },
  不便: { r: "ふべん", hard: true },
  時間: { r: "じかん" },
  長さ: { r: "ながさ", hard: true },
  大体: { r: "だいたい", hard: true },
  改札: { r: "かいさつ" },
  券売機: { r: "けんばいき" },
  乗り換え: { r: "のりかえ" },
  出口: { r: "でぐち" },
  東口: { r: "ひがしぐち" },
  西口: { r: "にしぐち" },
  歩: { r: "ある" },
  歩いて: { r: "あるいて" },
  目的地: { r: "もくてきち", hard: true },
  所要時間: { r: "しょようじかん", hard: true },
  定期券: { r: "ていきけん" },
  有効期限: { r: "ゆうこうきげん" },
  今月末: { r: "こんげつまつ" },
  月末: { r: "げつまつ" },
  曖昧: { r: "あいまい", hard: true },
  区間: { r: "くかん", hard: true },
  窓口: { r: "まどぐち" },
  落とし物: { r: "おとしもの" },
  手数料: { r: "てすうりょう" },
  三百円: { r: "さんびゃくえん" },
  遺失物: { r: "いしつぶつ", hard: true },
  手続き: { r: "てつづき", hard: true },
  新宿: { r: "しんじゅく" },
  山手線: { r: "やまのてせん" },

  /* ----- counters and common N4-N3 vocabulary ----- */
  一人: { r: "ひとり" },
  一晩: { r: "ひとばん", hard: true },
  二人: { r: "ふたり" },
  三人: { r: "さんにん" },
  今日: { r: "きょう" },
  明日: { r: "あした" },
  今朝: { r: "けさ" },
  今晩: { r: "こんばん" },
  毎日: { r: "まいにち" },
  今週: { r: "こんしゅう" },
  先週: { r: "せんしゅう" },
  先月: { r: "せんげつ" },
  今月: { r: "こんげつ" },

  /* ----- food / ordering vocabulary ----- */
  ビール: { r: "ビール" },
  酎ハイ: { r: "ちゅうハイ", hard: true },
  日本酒: { r: "にほんしゅ" },
  焼酎: { r: "焼酎" },
  食べ物: { r: "たべもの" },
  甘い: { r: "あまい", hard: true },
  辛: { r: "から", hard: true },
  辛い: { r: "からい", hard: true },
  美味しい: { r: "おいしい", hard: true },
  まずい: { r: "まずい", hard: true },
  温かい: { r: "あたたかい", hard: true },
  冷たい: { r: "つめたい", hard: true },

  /* ----- particles and grammar (for marker text we want to render with readings) ----- */
  何: { r: "なに", hard: true },
  誰: { r: "だれ", hard: true },
  どれ: { r: "どれ", hard: true },
  どちら: { r: "どちら" },
  どう: { r: "どう", hard: true },
  どうしました: { r: "どうしました" },

  /* ----- polite / keigo ----- */
  なさいます: { r: "なさいます" },
  します: { r: "します" },
  致します: { r: "いたします", hard: true },
  ございます: { r: "ございます" },

  /* ----- small pragmatic words used by the model ----- */
  少し: { r: "すこし" },
  少し待って: { r: "すこしまって" },
  名義: { r: "でんの", hard: true },
  俺: { r: "おれ", hard: true },
  私: { r: "わたし", hard: true },
  先輩: { r: "せんぱい", hard: true },
  後輩: { r: "こうはい", hard: true },
  田中: { r: "たなか" },
  同じ: { r: "おなじ", hard: true },
  分: { r: "ぶん", hard: true },
  同: { r: "おな", hard: true },
};

/** CJK ideographs. A reading on a key that contains none of these is skipped. */
const KANJI = /[一-鿿]/;

/**
 * Keys with at least one kanji. Cached so the segmentation loop does not rescan.
 * Pure kana entries are kept in the dictionary for lookup completeness; they simply
 * never appear as ruby segments.
 */
const KANJI_KEYS: string[] = Object.keys(RAW)
  .filter((k) => KANJI.test(k))
  .sort((a, b) => b.length - a.length);

/**
 * Whether `key` contains any kanji. Pure-kana keys still live in RAW for
 * backwards compatibility but are filtered out of the matcher.
 */
export function hasKanji(key: string): boolean {
  return KANJI.test(key);
}

/**
 * The reading for a surface form, or undefined if the dictionary does not know
 * it. Pure-kana forms are returned only when explicitly registered.
 */
export function lookup(surface: string): Reading | undefined {
  return RAW[surface];
}

/** Whether the surface is in the dictionary AND has at least one kanji. */
export function isKnown(surface: string): boolean {
  return KANJI.test(surface) && RAW[surface] !== undefined;
}

/**
 * One pass of segmentation. The output alternates between dictionary matches and
 * plain-text runs; a run of characters with no dictionary match is a single
 * `plain` segment so the renderer can skip a tag.
 */
export type Segment =
  | { kind: "plain"; text: string }
  | { kind: "ruby"; text: string; reading: string; hard: boolean };

export function segmentForFurigana(str: string): Segment[] {
  const out: Segment[] = [];
  const n = str.length;
  let i = 0;
  outer: while (i < n) {
    for (const key of KANJI_KEYS) {
      if (str.startsWith(key, i)) {
        const entry = RAW[key]!;
        out.push({ kind: "ruby", text: key, reading: entry.r, hard: !!entry.hard });
        i += key.length;
        continue outer;
      }
    }
    // No dictionary match at position i: collect the longest run of
    // dictionary-less characters, so we emit one segment per gap rather than
    // one per character.
    let j = i + 1;
    scan: while (j < n) {
      for (const key of KANJI_KEYS) {
        if (str.startsWith(key, j)) break scan;
      }
      j++;
    }
    out.push({ kind: "plain", text: str.slice(i, j) });
    i = j;
  }
  return out;
}