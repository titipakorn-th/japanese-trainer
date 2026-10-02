import { splitSentences } from "@/lib/sentences";
import { envNum } from "./pacing";
import type { Sprint, Turn, WordLedger, WordSlot } from "@/lib/types";

/**
 * The session's New Word budget, and the ledger that says how much is spent.
 *
 * A session targets ten words, split roughly five genuinely new and five drawn
 * from the Fumble Deck. The split is the part that carries the product's argument:
 * a word never seen is a fact, and a word that was failed and then met again under
 * pressure is a trained skill, so the deck half is the more valuable half and gets
 * a budget of its own rather than whatever is left over.
 *
 * The five new words are not chosen from a vocabulary list. They are the words the
 * scene briefs already carry — one per sprint — which is why `newTarget` is the
 * number of sprints in the plan rather than a constant. A four-sprint session then
 * targets four new and five deck, and a six-sprint session targets six and five;
 * the ten in the issue is the five-sprint default rather than a number the app
 * insists on. Deriving it this way also means the new half of the budget is
 * already concrete before the first model call, so the planner has something to
 * aim at on turn one instead of a quota it has to discover.
 *
 * A sprint carries at most three New Words. More than that is where conversations
 * start stalling: the partner is doing the learner's vocabulary work instead of
 * being a person in a room, and the learner stops following the scene. The cap is
 * enforced prospectively, by telling the partner how much of the sprint's
 * allowance is left, because a cap enforced after the fact by dropping markers
 * would be a cap the transcript silently lies about.
 *
 * Everything here is derived from committed turns. There is no counter kept
 * alongside, so a reload and a live stream cannot disagree, and a word the model
 * claimed to introduce without ever marking does not exist as far as the rail is
 * concerned.
 */

/** Words drawn from the Fumble Deck that a session aims to put back in play. */
const DECK_TARGET = 5;

/**
 * The most New Words one sprint may carry.
 *
 * The issue asks for 2–3 as a working range and states 3 as the ceiling, so 3 is
 * a rule and not a default. It is deliberately not read from the environment:
 * every other figure in this file is a target the learner or the operator may
 * reasonably want to move, and this one is a correctness boundary — a scene with
 * four New Words in it has stopped being a conversation, and no deployment should
 * be able to configure that away.
 */
const MAX_PER_SPRINT = 3;

/**
 * How many already-met words are named to the partner on any one turn.
 *
 * Prompt length is paid twice — once in prefill, once in how much the model
 * thinks about the job — and a partner handed twenty words to weave back in will
 * weave in none of them, or will stop being a person in a room. The most recent
 * few are also the ones most likely to still be in the learner's short-term reach,
 * so the list is the tail rather than the whole session.
 */
const MET_WORDS_FOR_PROMPT = 6;

export function wordBudget(sprintCount: number): Pick<
  WordLedger,
  "target" | "newTarget" | "deckTarget" | "maxPerSprint"
> {
  const newTarget = Math.max(1, sprintCount);
  const deckTarget = Math.round(envNum(process.env.DECK_WORDS_PER_SESSION, DECK_TARGET));
  return { newTarget, deckTarget, target: newTarget + deckTarget, maxPerSprint: MAX_PER_SPRINT };
}

/**
 * Which sentence of `text` a character offset falls in.
 *
 * The issue requires a New Word to be needed "again later in the same Session in a
 * different sentence". Different turns already give different sentences, so this
 * only bites when the partner introduces and then reuses a word inside one reply —
 * which is the case worth catching, because a word twice in the same sentence is
 * a repetition, not a second meeting, and asking the learner to recall it at the
 * debrief would be asking them to remember a stumble.
 *
 * An unterminated tail counts as its own sentence, so a word in the last clause of
 * a two-sentence reply is a different sentence from one in the first.
 */
function sentenceAt(text: string, offset: number): number {
  const { sentences } = splitSentences(text);
  let cursor = 0;
  for (let i = 0; i < sentences.length; i++) {
    const end = cursor + (sentences[i]?.length ?? 0);
    if (offset < end) return i;
    cursor = end;
  }
  return sentences.length;
}

/**
 * The ledger, rebuilt from the turns that were actually committed.
 *
 * Walks partner turns in order and records the first meeting of each distinct
 * word, then lets later `revisit` markers mark those words as needed again. A
 * `revisit` naming a word that was never marked as met is ignored: the word is
 * visibly in the transcript, but the app does not know when it was introduced, so
 * it cannot honestly claim a first meeting and a second one. That is a partner
 * mistake, and hiding it would be worse than showing a word with no ledger entry.
 *
 * Only partner turns are read. A marker on a learner turn is a fumble, and a fumble
 * is the learner failing to produce a word — the opposite of a word being met.
 */
export function buildWordLedger(turns: Turn[], sprintCount: number): WordLedger {
  const budget = wordBudget(sprintCount || 1);

  // Every word met, including any past the budget. `slots` is the capped view the
  // rail draws; this is the truth the debrief and the `seenAgain` count read, so a
  // word met as the eleventh is still reported as the eleventh rather than being
  // invisible because the grid stopped drawing.
  const met: WordSlot[] = [];
  const slots: WordSlot[] = [];
  const bySurface = new Map<string, WordSlot>();
  // Which sentence of its own turn each word was first met in, so a revisit inside
  // one reply can be compared against it. Across turns it is not needed: a later
  // turn is by construction a different sentence.
  const firstSentence = new Map<string, number>();
  // The turn a word was first met in, so the same-reply check above can tell
  // "reused in this same sentence" from "reused in a later one".
  const slotFirstTurn = new Map<string, number>();
  let newMet = 0;
  let deckMet = 0;

  for (const turn of turns) {
    if (turn.role !== "partner") continue;

    for (const marker of turn.markers) {
      if (marker.kind === "revisit") {
        const slot = bySurface.get(marker.surface);
        if (!slot) continue;
        // Only worth comparing when the reuse is in the same reply, which is the
        // only way two uses can land in one sentence. A later turn is a different
        // sentence by construction, so the check is skipped rather than faked.
        if (turn.id === slotFirstTurn.get(marker.surface)) {
          const first = firstSentence.get(marker.surface);
          if (first !== undefined && sentenceAt(turn.text, marker.start) === first) continue;
        }
        slot.seenAgain = true;
        continue;
      }

      if (marker.kind !== "new" && marker.kind !== "deck") continue;
      if (bySurface.has(marker.surface)) continue;

      const slot: WordSlot = {
        surface: marker.surface,
        reading: marker.reading,
        meaning: marker.meaning,
        kind: marker.kind,
        seenAgain: false,
      };
      bySurface.set(marker.surface, slot);
      firstSentence.set(marker.surface, sentenceAt(turn.text, marker.start));
      slotFirstTurn.set(marker.surface, turn.id);
      met.push(slot);
      if (marker.kind === "new") newMet++;
      else deckMet++;
      if (slots.length < budget.target) slots.push(slot);
    }
  }

  return {
    ...budget,
    slots,
    newMet,
    deckMet,
    revisited: met.filter((s) => s.seenAgain).map((s) => s.surface),
    // Counted over every word met, not over the drawn slots. Capping this at the
    // grid would make an overrun of good behaviour look like nothing happened.
    seenAgain: met.filter((s) => s.seenAgain).length,
  };
}

/**
 * The already-met words, most recent first, for naming back to the partner.
 *
 * Deck words are included. They have their own block in the prompt too, but that
 * one asks the partner to get the *learner* to produce the word, while this asks
 * the partner to *use* it again — two different acts, so the two instructions
 * reinforce rather than compete. Excluding them would have left half the budget
 * unreachable for the second meeting, and it is the half the issue calls the more
 * valuable one.
 */
export function metWords(turns: Turn[], limit = MET_WORDS_FOR_PROMPT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "partner") continue;
    for (const marker of turn.markers) {
      if (marker.kind !== "new" && marker.kind !== "deck") continue;
      if (seen.has(marker.surface)) continue;
      seen.add(marker.surface);
      out.push(marker.surface);
    }
  }
  return out.slice(-limit).reverse();
}

/**
 * How many more New Words this sprint may carry, and how many the session has left.
 *
 * The sprint cap outranks the session target. A session that is one word short of
 * its budget does not get to cram a fourth word into a scene that already has
 * three — the cap is the one that keeps a conversation from stalling, and the
 * target is explicitly a target.
 *
 * A strained session outranks both. Once the conversation has shown strain the
 * allowance is zero regardless of what the target says, and the whole remaining
 * budget moves to the Fumble Deck, because a tenth new word bought with a
 * stalled scene is a word the learner reads rather than one they speak. This is
 * the whole of issue #10's mechanism: the prompt already renders a zero
 * allowance as "new は0個" plus the deck instruction, so the gate does not have
 * to touch the prompt at all. See `docs/adr/0013-strain-signals.md`.
 */
export function newWordAllowance(
  turns: Turn[],
  sprint: Sprint | null,
  sprints: Sprint[],
  strained = false,
): { thisSprint: number; thisTurn: number } {
  if (strained) return { thisSprint: 0, thisTurn: 0 };

  const budget = wordBudget(sprints.length || 1);
  // No sprint means the scene has not been opened, so it has spent nothing and
  // both the sprint and the per-turn allowance are at their ceiling.
  if (!sprint) return { thisSprint: budget.maxPerSprint, thisTurn: 1 };

  const inSprint = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== "partner" || turn.sprintId !== sprint.id) continue;
    for (const marker of turn.markers) {
      if (marker.kind === "new") inSprint.add(marker.surface);
    }
  }
  const left = Math.max(0, budget.maxPerSprint - inSprint.size);
  return { thisSprint: left, thisTurn: Math.min(1, left) };
}

/**
 * The deck words to target this session, capped.
 *
 * The deck is unbounded — a learner can fumble forty words — and the budget is
 * five. The cap takes the worst offenders first, which is what the deck view is
 * already ordered by, so the words needing the most work are the ones that get
 * another chance and the long tail waits for a later session.
 */
export function targetDeckWords(deck: string[], limit = DECK_TARGET): string[] {
  return deck.slice(0, Math.max(0, limit));
}
