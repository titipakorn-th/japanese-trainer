import type { Turn } from "@/lib/types";

/**
 * What the partner does next, decided before the model is asked.
 *
 * The spec asks for four things of the partner that a prompt alone does not
 * deliver: follow up rather than only answer, complicate things when the learner
 * is coping, slow down and rephrase when they are clearly lost, and survive the
 * learner saying they do not know a word. Each is a stance — a line the prompt
 * switches on — and each is chosen here from what the learner actually wrote, so
 * the decision is deterministic, readable, and the same on a reloaded session as
 * it was live.
 *
 * The order matters. "I don't know the word" is checked before "lost", because a
 * learner who says that has told us exactly what is wrong and deserves the word
 * handed to them rather than a slower question. "Doing well" is checked last,
 * because a learner we have called lost must never be handed a complication.
 */

export type Stance = "plain" | "harder" | "slow" | "give-word";

export interface StanceSignal {
  stance: Stance;
}

/**
 * The learner has said, in Japanese, that they do not have the word.
 *
 * This is the one case where the partner stops being a conversation partner for
 * a moment: the word goes into the sentence, in the scene, with nothing attached
 * to it. Anything the model adds here — a translation, an aside, a word of
 * encouragement — is the exchange stopping, which is the failure this exists to
 * prevent.
 */
const NO_WORD = ["何て言う", "何ていう", "なんて言う", "なんていう", "どう言い"];

/** The same request, in a script the learner fell back to. */
const NO_WORD_LATIN = /how do (you|i) say|what'?s the word|don'?t know (the|this) word/i;

/** Asking for a repeat, which is the other face of being lost. */
const AGAIN = ["もう一度", "もう一回", "もういちど", "聞こえ", "聞こえない", "わかりません", "分かりません"];

/** A bare back-channel is not an answer that moves the scene along. */
const SHORT_ENOUGH = 5;

/** Answering at this length, this quickly, without a correction, is coping. */
const COMFORTABLE = 8;
const BRISK_MS = 25_000;

/** Punctuation and spaces are not content. */
function bare(text: string): string {
  return text.replace(/[\s。、！？!?「」『』]/g, "");
}

function isShort(turn: Spoken): boolean {
  return bare(turn.text).length <= SHORT_ENOUGH;
}

function learnerTurns(turns: Spoken[]): Spoken[] {
  return turns.filter((t) => t.role === "learner");
}

function said(turn: Spoken, needles: string[]): boolean {
  return needles.some((n) => turn.text.includes(n));
}

/** Most of what the learner writes is Latin script once they have given up on it. */
function mostlyLatin(text: string): boolean {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return false;
  const latin = chars.match(/[A-Za-z0-9]/g)?.length ?? 0;
  return latin / chars.length > 0.5;
}

/**
 * The four things the detector reads off a turn. Narrower than `Turn` on
 * purpose: the detector does not need ids or sequence numbers to know how someone
 * is coping, and depending on four fields rather than a whole entity keeps it
 * usable on a partial history.
 */
export interface Spoken {
  role: Turn["role"];
  text: string;
  naturalPhrasing: string | null;
  responseMs: number | null;
}

/**
 * The stance for the reply that answers the turns so far.
 *
 * Pure, and a function of committed turns only, so the debrief can replay it
 * later and get the same answer the live turn got.
 */
export function readStance(turns: Spoken[]): StanceSignal {
  const learner = learnerTurns(turns);
  const last = learner[learner.length - 1];

  // Nothing has been said yet: the partner is opening a scene, and an opening has
  // nothing to react to and nothing to complicate.
  if (!last) return { stance: "plain" };

  if (NO_WORD.some((n) => last.text.includes(n)) || NO_WORD_LATIN.test(last.text)) {
    return { stance: "give-word" };
  }

  const lastFew = learner.slice(-3);
  const shortRun = lastFew.length >= 2 && lastFew.filter(isShort).length >= 2;
  const askedAgain = said(last, AGAIN) || mostlyLatin(last.text);
  if (askedAgain || shortRun) {
    return { stance: "slow" };
  }

  // One short turn is a normal answer — 「はい。」 answers a real question. Three
  // or four in a row is a learner going quiet, which ends the practice for the
  // day if nothing is done about it.
  if (learner.length >= 4 && lastFew.filter(isShort).length === lastFew.length) {
    return { stance: "slow" };
  }

  const recent = learner.slice(-2);
  const coping =
    recent.length >= 2 &&
    recent.every((t) => t.text.length >= COMFORTABLE) &&
    recent.every((t) => !t.naturalPhrasing) &&
    recent.every((t) => t.responseMs === null || t.responseMs <= BRISK_MS);

  if (coping) {
    return { stance: "harder" };
  }

  return { stance: "plain" };
}

/**
 * The stance used for each exchange in a sprint, in order.
 *
 * Entry i is the stance behind the partner's reply to learner turn i, derived
 * from the turns before it — the same derivation the live turn used, so the
 * debrief reports what actually happened rather than what a fresh read of the
 * finished transcript would say.
 */
export function stanceTrail(turns: Spoken[]): StanceSignal[] {
  const trail: StanceSignal[] = [];
  const before: Spoken[] = [];
  for (const turn of turns) {
    if (turn.role === "learner") trail.push(readStance(before));
    before.push(turn);
  }
  return trail;
}
