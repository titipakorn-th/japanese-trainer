import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSystemPrompt, type PromptContext } from "./prompt";

/**
 * The strain branch of the marker hint.
 *
 * `prompt.ts` is the load-bearing file in this project and the reason every
 * slice is expected to drive the app and read the deck count off the coach rail
 * before shipping. A regression here is invisible in the conversation itself: the
 * partner keeps talking perfectly while the Fumble Deck quietly stops being
 * worked. So the tests below are about the one property that is cheap to check
 * mechanically — that strain is the *only* thing that changes the instruction.
 *
 * That was verified against `main` directly rather than asserted. Hashing the
 * built prompt for six ordinary contexts on both trees returned identical
 * digests, and the four strained contexts all changed. The property tests here
 * are the durable version of that comparison; they survive a legitimate prompt
 * edit, which golden hashes would not.
 *
 * The instruction is a *different* instruction, not a longer one. A strained
 * session told to add "0〜1" deck markers alongside "new は0個" has been told to
 * introduce nothing, and a scene the partner is not told to put anything into is
 * a scene that goes flat.
 */

const brief = {
  slug: "counter",
  persona: "店員",
  place: "居酒屋",
  situation: "注文",
  goal: "肴とビールを注文する",
  openingLine: "いらっしゃいませ。",
  correctionLine: "すみません、お予算は？",
  closingLine: "ごゆっくり。",
  word: { surface: "予算", reading: "よさん", meaning: "budget", example: "予算は？" },
};

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    brief,
    moment: "reply",
    stance: "plain",
    earlier: [],
    deckWords: ["辛口"],
    grammarPoint: null,
    metWords: ["生ビール"],
    allowance: { thisSprint: 2, thisTurn: 1 },
    ...over,
  };
}

const STRAIN_MARKER = "残りの場面は";

test("an ordinary session is told nothing about strain", () => {
  const prompt = buildSystemPrompt(ctx());

  assert.doesNotMatch(prompt, new RegExp(STRAIN_MARKER), "an unstrained prompt must not mention it");
  assert.match(prompt, /deck を0〜1/, "the ordinary deck line is unchanged");
  assert.match(prompt, /new を0〜1/, "the ordinary new-word line is unchanged");
});

test("every ordinary context is unchanged, not just the common one", () => {
  // The bug this guards is a change that fires in one situation and not another.
  // Opening, closing, give-word and a used-up sprint cap all route through
  // markerHint by different paths, and a cap reaching zero is the case most
  // likely to be mistaken for strain.
  for (const over of [
    { moment: "opening" as const, allowance: { thisSprint: 3, thisTurn: 1 } },
    { moment: "closing" as const },
    { stance: "give-word" as const },
    { allowance: { thisSprint: 0, thisTurn: 0 } },
  ]) {
    const prompt = buildSystemPrompt(ctx(over));
    assert.doesNotMatch(
      prompt,
      new RegExp(STRAIN_MARKER),
      `ordinary context ${JSON.stringify(over)} must not mention strain`,
    );
  }
});

test("a strained session with deck words spends the turn on the deck", () => {
  const prompt = buildSystemPrompt(ctx({ strained: true }));

  assert.match(prompt, /new は0個/);
  assert.match(prompt, new RegExp(STRAIN_MARKER));
  assert.match(prompt, /deck を必ず1つ/, "a deck marker becomes required, not optional");
  assert.doesNotMatch(prompt, /deck を0〜1/, "the optional deck line must not also be there");
});

test("a strained session with no deck words falls back to revisiting what was met", () => {
  // An empty deck with a strained learner is the case that would otherwise go
  // quiet: told to mark nothing, with no deck word to aim at, the partner has
  // nothing to do. The words already met are the only honest target left.
  const prompt = buildSystemPrompt(ctx({ strained: true, deckWords: [] }));

  assert.match(prompt, /new は0個/);
  assert.match(prompt, /revisit/, "the fallback uses the existing revisit machinery");
  assert.match(prompt, /生ビール/, "and it names a word the partner has already met");
  assert.doesNotMatch(prompt, /deck を必ず1つ/, "there is no deck word to demand");
});

test("a strained session with neither deck nor met words is told to keep going", () => {
  const prompt = buildSystemPrompt(ctx({ strained: true, deckWords: [], metWords: [] }));

  assert.match(prompt, /new は0個/);
  assert.match(prompt, /印は付けなくていい/, "nothing to mark is better than a silent scene");
  assert.doesNotMatch(prompt, new RegExp(STRAIN_MARKER));
});

test("a closing line is still a closing line when the session is strained", () => {
  // A sign-off is one short line and a marker in it is a marker in the least
  // useful sentence of the session. This has to hold for a strained session too,
  // or stopping injection would make every consolidation day end on a word the
  // learner was never asked to produce.
  const strained = buildSystemPrompt(ctx({ strained: true, moment: "closing" }));
  const ordinary = buildSystemPrompt(ctx({ moment: "closing" }));

  assert.equal(strained, ordinary, "closing is closing, however the session is going");
});

test("strained is not inferred from a spent allowance", () => {
  // A scene that has used its three words is a normal scene finishing normally.
  // Conflating a zero allowance with strain would push the Fumble Deck at every
  // capped scene in every healthy session, which is the opposite of the point.
  const capped = buildSystemPrompt(ctx({ allowance: { thisSprint: 0, thisTurn: 0 } }));

  assert.match(capped, /new は0個/, "the cap still stops new words");
  assert.doesNotMatch(capped, new RegExp(STRAIN_MARKER), "but it is not strain");
  assert.doesNotMatch(capped, /deck を必ず1つ/);
});

test("the marker hint never asks for a new word on a strained turn", () => {
  for (const over of [
    { deckWords: ["辛口"], metWords: ["生ビール"] },
    { deckWords: [], metWords: ["生ビール"] },
    { deckWords: [], metWords: [] },
  ]) {
    const prompt = buildSystemPrompt(ctx({ strained: true, ...over }));
    assert.doesNotMatch(
      prompt,
      /new を1つ|new を0〜/,
      `a strained turn must not offer a new word: ${JSON.stringify(over)}`,
    );
  }
});
