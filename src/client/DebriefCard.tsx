"use client";

import type { Debrief } from "@/lib/types";

/**
 * What happened in a sprint, in the place the sprint happened.
 *
 * The card sits in the transcript right after the last turn of the scene, so the
 * feedback arrives while the moment is still fresh — which is the entire reason
 * the session is 4–6 short scenes rather than one half hour. Everything on it is
 * counted from committed turns; there is no model opinion of the learner on this
 * card, and a fumble's second attempt goes at the top of it once fumble capture
 * lands.
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

      {debrief.words.length ? (
        <div className="words">
          {debrief.words.map((word) => (
            <span key={word.surface} className="word" title={word.meaning}>
              <b className="jp">{word.surface}</b>
              <i className="jp">{word.reading}</i>
            </span>
          ))}
        </div>
      ) : null}

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
    </article>
  );
}
