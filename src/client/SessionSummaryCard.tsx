"use client";

import { humanMs } from "@/lib/measure";
import { summaryLines, type SessionSummary, type TurnPace } from "@/lib/summary";
import type { Marker } from "@/lib/types";

/**
 * The end of the session, as something the learner can actually read.
 *
 * This replaces the two-line sign-off the session used to end on. The point of
 * the panel is the sequence, not the average: a learner who answers 5s, 4s, 9s,
 * 3s has learned something a mean of 5.25s cannot tell them, and the bars are how
 * the shrinking the product exists to produce becomes visible. A turn they
 * walked away from is marked on its own bar, because that is the failure this
 * app measures most precisely and the one most worth being able to point at.
 *
 * Everything on it is counted from committed turns and fumbles. There is no
 * model opinion of the learner here, and where the numbers are too thin to mean
 * anything the panel says nothing rather than rounding a guess up into a
 * conclusion.
 */

/** Height of the tallest bar, in px. Short enough to sit under a chat app. */
const CHART_PX = 66;

export function SessionSummaryCard({ summary }: { summary: SessionSummary }) {
  const lines = summaryLines(summary);

  return (
    <section className="summary" aria-label="Session summary">
      <ol className="summary-lines">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>

      {summary.pace.length ? (
        <PaceChart pace={summary.pace} meanMs={summary.meanResponseMs} bailOutIds={summary.bailOutTurnIds} />
      ) : null}

      <dl className="summary-facts">
        <Fact
          label="Scenes"
          value={summary.sprintsPlanned > 0 ? `${summary.sprintsClosed} of ${summary.sprintsPlanned}` : "—"}
        />
        <Fact
          label="Average"
          value={summary.meanResponseMs === null ? "—" : humanMs(summary.meanResponseMs)}
        />
        <Fact
          label="Slowest one"
          value={summary.slowestMs === null ? "—" : humanMs(summary.slowestMs)}
        />
        <Fact
          label="Walked away"
          value={summary.bailOuts === 0 ? "never" : `${summary.bailOuts}×`}
          tone={summary.bailOuts > 0 ? "fumble" : undefined}
        />
      </dl>

      {summary.words.length ? (
        <div className="summary-words">
          <div className="summary-words-head">
            New words met — {summary.words.length} this session
          </div>
          <div className="words">
            {summary.words.map((word) => (
              <Word key={word.surface} word={word} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="fact" data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Word({ word }: { word: Pick<Marker, "surface" | "reading" | "meaning"> }) {
  return (
    <span className="word" title={word.meaning}>
      <b className="jp">{word.surface}</b>
      <i className="jp">{word.reading}</i>
    </span>
  );
}

/**
 * One bar per learner turn, in the order they happened.
 *
 * Bars are scaled against the slowest turn in the session rather than a fixed
 * ceiling, so the shape of the session is legible whatever the absolute numbers
 * are — a session where everything took 4s should not look empty. The dashed
 * line is the average, and where the bars sit against it is the whole point:
 * left of it the learner was quick, right of it they stalled.
 *
 * A turn the browser could not time still gets a bar, drawn flat and dim, because
 * it happened and dropping it would quietly make the session look tighter than
 * it was. The count of those is in the summary lines.
 */
function PaceChart({
  pace,
  meanMs,
  bailOutIds,
}: {
  pace: TurnPace[];
  meanMs: number | null;
  bailOutIds: number[];
}) {
  const walked = new Set(bailOutIds);
  const times = pace.map((p) => p.responseMs).filter((ms): ms is number => ms !== null);
  const max = times.length ? Math.max(...times) : 0;
  // Every turn equal — including a set of zeroes — is a real shape, so the bars
  // are drawn at full height rather than being a divide by zero away from nothing.
  const scale = (ms: number): number => (max > 0 ? Math.max(0.06, ms / max) : 1);
  const meanFraction = meanMs !== null && max > 0 ? meanMs / max : null;

  return (
    <figure className="pace">
      <figcaption>
        Time to answer, turn by turn
        {times.length ? (
          <span className="pace-scale jp">
            slowest {humanMs(max)} · dashed line is the average
          </span>
        ) : null}
      </figcaption>

      <div className="pace-plot" style={{ height: `${CHART_PX}px` }}>
        {meanFraction !== null ? (
          <div className="pace-mean" style={{ bottom: `${meanFraction * 100}%` }} aria-hidden="true" />
        ) : null}

        {pace.map((p, i) => {
          const bailed = walked.has(p.id);
          const unmeasured = p.responseMs === null;
          const label =
            `Turn ${i + 1}` +
            (p.sprintSeq !== null ? `, sprint ${p.sprintSeq}` : "") +
            (unmeasured ? ": not timed" : `: ${humanMs(p.responseMs)}`) +
            (bailed ? ", you walked away from this one" : "");
          return (
            <div
              key={p.id}
              className="pace-col"
              data-bail={bailed ? "1" : "0"}
              data-timed={unmeasured ? "0" : "1"}
            >
              {i > 0 && p.sprintSeq !== pace[i - 1]!.sprintSeq ? (
                <span className="pace-scene" aria-hidden="true" />
              ) : null}
              <span className="sr-only">{label}</span>
              <span
                className="pace-bar"
                style={{ height: `${(unmeasured ? 0.06 : scale(p.responseMs!)) * 100}%` }}
                title={label}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
    </figure>
  );
}
