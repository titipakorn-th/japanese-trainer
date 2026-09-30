import type { Scenario } from "@/lib/types";

/**
 * A grammar pattern taught one-per-session, chosen to make the learner's
 * sentences shorter.
 *
 * The selection is the interesting part. A pattern that does not shorten
 * anything does not earn the slot, so each entry carries a plain-language
 * `shortens` — what it lets the learner express in one short sentence instead
 * of two clumsy ones — and a `why` — why the pattern exists, not just what its
 * form is. Both are shown on the coach rail and quoted into the partner's
 * system prompt, so the same line carries the rationale to the model and to
 * the learner.
 *
 * Delivery is what separates a pattern from a memorised phrase. The partner
 * uses each point three or four times in different sentence frames across the
 * session, so the prompt tells the model to spread usage across turns rather
 * than load it onto one reply.
 *
 * `scenarios` lists which families have natural leverage for the pattern.
 * A pattern that fits one family and not another is fine: selection filters by
 * family, and a learner who picked the train family should not be handed a
 * pattern that does not shorten anything they will say tonight.
 */

export interface GrammarPoint {
  slug: string;
  /** The pattern as written. Used in the prompt and the rail. */
  name: string;
  level: "N4" | "N3";
  /**
   * What this pattern lets the learner express in one short sentence instead
   * of two clumsy ones. The rationale the issue asks for.
   */
  shortens: string;
  /**
   * Why the pattern exists in plain language, not just what its form is.
   * Shown on the coach rail so the learner connects the pattern to the
   * moment they needed it.
   */
  why: string;
  /** A concrete example sentence using the pattern. */
  example: string;
  /**
   * Scenario slugs where this pattern has natural leverage. Selection filters
   * by the scenario the learner picked; an empty list is a candidate the
   * catalog should remove.
   */
  scenarios: readonly string[];
}

export const GRAMMAR_POINTS: GrammarPoint[] = [
  {
    slug: "temoii",
    name: "〜てもいい",
    level: "N4",
    shortens:
      "「注文してもいいですか」「確認してもいいですか」で一文。「〜しても許されますか」「〜することはできますか」のかわりに使う。",
    why:
      "Permission and acceptability are one short sentence in Japanese; without this pattern you would spell out the condition instead of marking it as a tail.",
    example: "ビールを一杯頼んでもいいですか。",
    scenarios: ["izakaya", "train", "work"],
  },
  {
    slug: "teoku",
    name: "〜ておく",
    level: "N4",
    shortens:
      "「予約しておきます」「明日、連絡しておきます」で一文。「前もって〜します」「先に〜しておきます」のかわりに使う。",
    why:
      "Doing something in advance is one short sentence with this pattern; without it you would spell out the temporal ordering.",
    example: "明日、部長に連絡しておきます。",
    scenarios: ["izakaya", "work", "train"],
  },
  {
    slug: "teshimau",
    name: "〜てしまう",
    level: "N4",
    shortens:
      "「遅れてしまいました」「全部食べてしまいました」で一文。「うっかり〜してしまった」「完全に〜してしまった」のかわりに使う。",
    why:
      "An action that completes — often unintentionally — is one short form with this pattern; without it you would qualify it with either regret or completeness.",
    example: "電車を乗り過ごしてしまいました。",
    scenarios: ["izakaya", "train", "work"],
  },
  {
    slug: "younisuru",
    name: "〜ようにする",
    level: "N4",
    shortens:
      "「遅れないようにします」「期限までに届くようにします」で一文。「〜するように努力します」「〜するように気をつけます」のかわりに使う。",
    why:
      "An intent to make something happen is one short sentence with this pattern; without it you would qualify it with effort or care.",
    example: "明日、遅れないようにします。",
    scenarios: ["work"],
  },
  {
    slug: "baii",
    name: "〜ばいい",
    level: "N3",
    shortens:
      "「何時までに連絡すればいいですか」「どう言えばいいですか」で一文。「〜するのが適切ですか」「〜と言うべきですか」のかわりに使う。",
    why:
      "Asking what to say or do is one short question with this pattern; without it you would describe the situation instead of asking for the form.",
    example: "何時までに連絡すればいいですか。",
    scenarios: ["work", "train", "izakaya"],
  },
  {
    slug: "tai",
    name: "〜たい",
    level: "N4",
    shortens:
      "「ビールを注文したいです」「もう一度行きたいです」で一文。「〜したいです」「〜したいと思っています」のかわりに使う。",
    why:
      "Wanting to do something is one short sentence with this pattern; without it you would describe the wanting rather than the thing wanted.",
    example: "お刺身を注文したいです。",
    scenarios: ["izakaya"],
  },
];

/** The level this version of the app teaches at. */
const ACTIVE_LEVEL: GrammarPoint["level"] = "N4";

export function getGrammarPoint(slug: string): GrammarPoint | null {
  return GRAMMAR_POINTS.find((g) => g.slug === slug) ?? null;
}

/**
 * The grammar point for a session, picked from those that fit the scenario
 * and the active level.
 *
 * A scenario that has only one fit is not a problem — it is the highest-
 * leverage option for that scenario by elimination. When several fit, the
 * least-recently-used wins so a learner who runs the izakaya family three
 * times in a row sees all three patterns rather than the same one twice.
 * Rotation is read from the session table on the same store the rest of the
 * app uses, so it survives a reload and a learner who picks up a different
 * device does not get a duplicate.
 */
export function pickGrammarPoint(scenario: Scenario, usage: Record<string, number> = {}): GrammarPoint {
  const fits = GRAMMAR_POINTS.filter(
    (g) => g.level === ACTIVE_LEVEL && g.scenarios.includes(scenario.slug),
  );
  const fallback = fits[0] ?? GRAMMAR_POINTS[0]!;

  if (fits.length <= 1) return fallback;

  let leastUsed = fits[0]!;
  let leastCount = usage[leastUsed.slug] ?? 0;
  for (const candidate of fits.slice(1)) {
    const count = usage[candidate.slug] ?? 0;
    if (count < leastCount) {
      leastUsed = candidate;
      leastCount = count;
    }
  }
  return leastUsed;
}