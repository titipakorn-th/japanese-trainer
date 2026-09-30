/**
 * Whether a model reply is usable enough to show a learner.
 *
 * Live in `src/lib` rather than in `turn.ts` because two places have to agree on
 * it exactly: the server decides whether to retry or commit, and the probe counts
 * how often that happens. A probe that answered the question its own way would
 * report a retry rate the app never experiences — which is how "2 of 7 replies
 * had no prose" became "0 of 7" without anyone checking that the two used the
 * same test.
 */

/** One third, loose on purpose: a reply with a stray English word is still a reply. */
const JAPANESE_SHARE = 1 / 3;

export function looksJapanese(text: string): boolean {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return false;
  const japanese = chars.match(/[぀-ヿ一-鿿]/g)?.length ?? 0;
  return japanese / chars.length > JAPANESE_SHARE;
}
