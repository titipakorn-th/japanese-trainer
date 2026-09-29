"use client";

import type { Sprint } from "@/lib/types";

/**
 * The session's plan, as a row of marks.
 *
 * The whole point of sprinting is that the learner can see the shape of the next
 * half hour: four to six scenes, this one now, and the next one already named.
 * A session that feels open-ended is the thing the design is avoiding, and this
 * is the cheapest way to make it concrete — the plan is written when the session
 * starts, not invented as it goes.
 */
export function SprintTrack({ sprints, full = false }: { sprints: Sprint[]; full?: boolean }) {
  return (
    <ol className="track" data-full={full ? "1" : "0"} aria-label="Sprint progress">
      {sprints.map((sprint) => (
        <li
          key={sprint.id}
          data-state={sprint.status === "closed" ? "done" : sprint.status}
          title={`${sprint.seq}. ${sprint.brief.persona} — ${sprint.brief.goal}`}
        >
          <span className="num">{sprint.seq}</span>
          {full ? <span className="what jp">{sprint.brief.persona}</span> : null}
        </li>
      ))}
    </ol>
  );
}
