import { SCENARIOS } from "./scenarios";
import type { GrammarPoint, Scenario } from "@/lib/types";

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
 * The fits map is what makes selection a function of the scenario. A pattern
 * that fits one family and not another is fine: a learner who picked the
 * train family should not be handed a pattern that does not shorten anything
 * they will say tonight. The map is checked against the scenario catalog at
 * module load, so a typo is a loud startup failure rather than a silent miss.
 */

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
  },
];

/** The level this version of the app teaches at. */
const ACTIVE_LEVEL: GrammarPoint["level"] = "N4";

/**
 * Which scenario families each pattern has natural leverage for.
 *
 * A pattern that fits one family and not another is fine: selection filters by
 * family. The map is keyed on the catalog's slugs and validated against the
 * scenario catalog at module load.
 */
const FITS_BY_SLUG: Record<GrammarPoint["slug"], readonly string[]> = {
  temoii: ["izakaya", "train", "work"],
  teoku: ["izakaya", "work", "train"],
  teshimau: ["izakaya", "train", "work"],
  younisuru: ["work"],
  tai: ["izakaya"],
};

// A typo in any fits list is a startup failure, not a silent miss: a scenario
// the catalog has never heard of can never match, and the session would run
// without a grammar point.
for (const [point, fits] of Object.entries(FITS_BY_SLUG)) {
  for (const scenario of fits) {
    if (!SCENARIOS.some((s) => s.slug === scenario)) {
      throw new Error(`grammarPoints: "${point}" lists unknown scenario "${scenario}"`);
    }
  }
}

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
 * Counts are read off the same session rows the rest of the app uses, so
 * the rotation survives a reload and a learner who picks up a different
 * device does not get a duplicate.
 *
 * `priorPickCount` is required: defaulting it to an empty object silently
 * disables rotation, which would hand the same pattern back to back. The
 * call site reads the count off the session table and passes it in.
 */
export function pickGrammarPoint(
  scenario: Scenario,
  priorPickCount: Record<string, number>,
): GrammarPoint {
  const fits = GRAMMAR_POINTS.filter(
    (g) => g.level === ACTIVE_LEVEL && (FITS_BY_SLUG[g.slug] ?? []).includes(scenario.slug),
  );
  if (fits.length === 0) {
    // Unreachable while the catalog stays in sync with the scenario catalog;
    // throwing surfaces drift loudly rather than handing the learner a
    // session with no grammar point.
    throw new Error(`grammarPoints: no point fits scenario "${scenario.slug}"`);
  }
  if (fits.length === 1) return fits[0]!;

  let leastUsed = fits[0]!;
  let leastCount = priorPickCount[leastUsed.slug] ?? 0;
  for (const candidate of fits.slice(1)) {
    const count = priorPickCount[candidate.slug] ?? 0;
    if (count < leastCount) {
      leastUsed = candidate;
      leastCount = count;
    }
  }
  return leastUsed;
}
