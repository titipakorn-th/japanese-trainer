"use client";

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

      {debrief.fumbles.length ? <FumbleList fumbles={debrief.fumbles} /> : null}
    </article>
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
