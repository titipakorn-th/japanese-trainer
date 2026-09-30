"use client";

import { useCallback, useState } from "react";
import type { Debrief, Fumble } from "@/lib/types";

/**
 * What happened in a sprint, in the place the sprint happened.
 *
 * The card sits in the transcript right after the last turn of the scene, so the
 * feedback arrives while the moment is still fresh — which is the entire reason
 * the session is 4–6 short scenes rather than one half hour. Everything on it is
 * counted from committed turns; there is no model opinion of the learner on this
 * card.
 *
 * Fumbles are listed alongside the corrections and the new words, in the same
 * `said → natural` shape, so the feedback the learner reads after the sprint is
 * one card rather than three. Each fumble carries the reason it was flagged, so
 * a learner who saw themselves abandon the turn can see the app saw it too.
 *
 * A drilled fumble carries a `drilled` marker so the learner can see which
 * moments the partner pulled them out of the conversation for. Drilled rows
 * still appear in the list — the drill is not a pass on the moment, it is a
 * retry — but the marker makes the trajectory legible at a glance.
 */

export function DebriefCard({ debrief }: { debrief: Debrief }) {
  return (
    <article className="debrief" aria-label={`Sprint ${debrief.seq} debrief`}>
      <header>
        <span className="sprint-no">Sprint {debrief.seq}</span>
        <span className="where jp">{debrief.place}</span>
      </header>

      <ul className="lines">
        {debrief.lines.map((line, i) => (
          <li key={i} data-kind={line.kind}>
            {line.text}
          </li>
        ))}
      </ul>

      {debrief.words.length ? <Recall words={debrief.words} /> : null}

      {debrief.corrections.length ? (
        <div className="quiet-list">
          {debrief.corrections.map((c, i) => (
            <div key={i} className="quiet-row">
              <span className="said jp">{c.said}</span>
              <span className="arrow">→</span>
              <span className="phrase jp">{c.natural}</span>
            </div>
          ))}
        </div>
      ) : null}

      {debrief.fumbles.length ? <FumbleList fumbles={debrief.fumbles} /> : null}
    </article>
  );
}

/**
 * The sprint's recall.
 *
 * The issue asks the debrief for "a short recall of that Sprint's New Words", and
 * the sentence that matters in the spec is the one that explains why: "recognition
 * is reading, retrieval is speaking, and only the second one is the skill being
 * trained." So the row is built the other way round from the transcript. The
 * *meaning* is shown and the *word* is the answer.
 *
 * A row that printed the word in bold and asked for its reading would be the exact
 * recognition the issue is trying to move past — the learner reads the surface, has
 * a flicker of "yes, that one", and has produced nothing. Here they are handed a
 * description and have to reach for the word themselves, which is the thing the
 * session spent half an hour setting up. The answer sits behind a tap, and it is
 * the same tap-to-reveal idiom the transcript already uses, so it is not a new
 * interaction to learn at the end of a scene.
 *
 * A Deck Word with no recorded meaning has nothing to work backwards from — the
 * deck marker carries the natural form and no gloss, because the partner already
 * speaks Japanese and the point of a deck word is the learner's own production of
 * it. Those rows fall back to showing the surface and asking for its reading, which
 * is recognition, and the row is marked so the learner is not sold a harder
 * question than the one they are being asked.
 *
 * Nothing is graded and nothing is stored. The app has no answer key it could score
 * a Japanese production against without string-matching a word, and a wrong score is
 * worse than no score: the learner would train against the app's judgement of their
 * recall rather than their own. Comparing what they produced against the answer in
 * front of them is something they can already do and is not the app's to automate.
 *
 * The reveal is local state and resets on reload. A learner who has already looked
 * does not get to un-look, and pretending otherwise would be a scoreboard.
 */
function Recall({
  words,
}: {
  words: Debrief["words"];
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  const reveal = useCallback((surface: string) => {
    setChecked((prev) => {
      if (prev.has(surface)) return prev;
      const next = new Set(prev);
      next.add(surface);
      return next;
    });
  }, []);

  // Two different populations, kept apart deliberately.
  //
  // `askable` is the set the recall can actually put to the learner: only a word
  // with a meaning can be worked backwards from, and a deck marker has none. Only
  // these get the "say the word" question.
  //
  // `againAmongAskable` is deliberately *not* the number of words with a second
  // meeting across the whole list. That count spans every word including the deck
  // ones, and using it as the numerator of an "N of M" against `askable` as the
  // denominator prints arithmetic that does not mean anything — the first version of
  // this copy managed to render "2 of 1". One population, one denominator, or the
  // sentence is not written at all.
  const askable = words.filter((w) => w.meaning);
  const againAmongAskable = askable.filter((w) => w.seenAgain).length;

  return (
    <div className="recall">
      <div className="recall-head">
        Say the words
        <span className="recall-sub">
          {askable.length === 0
            ? "Tap to check what you remember. Nothing here has a meaning recorded, so there is nothing to work backwards from."
            : againAmongAskable > 0
              ? `Read each meaning and say the word before you check. ${againAmongAskable} of these came round a second time, so they are the ones worth really trying.`
              : "Read each meaning and say the word before you check. None of these came round a second time this session, so this is closer to a read-through than a recall."}
        </span>
      </div>
      <ul className="recall-list">
        {words.map((word) => {
          const open = checked.has(word.surface);
          // Which way round the row runs. A word with a meaning is asked for by its
          // meaning; a word without one is asked for by its surface.
          const byMeaning = Boolean(word.meaning);
          const prompt = byMeaning ? word.meaning : null;
          return (
            <li
              key={word.surface}
              className="recall-row"
              data-open={open ? "1" : "0"}
              data-kind={word.kind}
            >
              {byMeaning ? (
                prompt ? (
                  <span className="recall-prompt">{prompt}</span>
                ) : null
              ) : (
                <span className="recall-cue">what was this?</span>
              )}
              {open ? (
                <span className="recall-answer">
                  <b className="jp">{word.surface}</b>
                  {word.reading ? <i className="jp">{word.reading}</i> : null}
                </span>
              ) : (
                <button
                  type="button"
                  className="recall-reveal"
                  onClick={() => reveal(word.surface)}
                  aria-label={`Reveal the word for ${byMeaning ? word.meaning : "this one"}`}
                >
                  check
                </button>
              )}
              {word.kind === "deck" ? <span className="recall-deck">deck</span> : null}
              {word.seenAgain ? <span className="recall-again">again</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FumbleList({ fumbles }: { fumbles: Fumble[] }) {
  return (
    <div className="fumble-list">
      <div className="fumble-list-head">Fumbles</div>
      {fumbles.map((f) => (
        <div key={f.id} className="fumble-row" data-drilled={f.drilled ? "1" : "0"}>
          <div className="fumble-reason-row">
            <div className="fumble-reason" data-reason={f.reason}>
              {f.reason}
            </div>
            {f.drilled ? (
              <div className="fumble-drilled" title="The partner asked the learner to retry this one">
                drilled
              </div>
            ) : null}
          </div>
          <div className="quiet-row">
            <span className="said jp">{f.surface || f.learnerSaid}</span>
            <span className="arrow">→</span>
            <span className="phrase jp">{f.natural}</span>
          </div>
          <div className="fumble-situation jp">{f.situation}</div>
        </div>
      ))}
    </div>
  );
}
