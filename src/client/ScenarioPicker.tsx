"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Scenario } from "@/lib/types";

/**
 * The picker, which exists because a thirty-minute session is a commitment and
 * the learner should make it with the day's need in mind rather than by opening
 * the app and finding out.
 *
 * Each family shows the sprints it contains, because a session is a run of them
 * and the choice is really "which kind of conversation today" rather than a title
 * the learner has to already recognise. The scene list is the honest description
 * of what the next thirty minutes will be.
 */
export function ScenarioPicker({
  scenarios,
  sprints,
  minutes,
  sprintMinutes,
}: {
  scenarios: Scenario[];
  sprints: number;
  minutes: number;
  sprintMinutes: number;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(slug: string) {
    if (starting) return;
    setStarting(slug);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: slug }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { id } = (await response.json()) as { id: string };
      router.push(`/session/${id}`);
    } catch {
      setError("Could not start a session. Is the server running?");
      setStarting(null);
    }
  }

  return (
    <main className="start">
      <header className="start-head">
        <h1>Start a session</h1>
        <p className="lede">
          {sprints} scenes of about {sprintMinutes} minutes, one after another, ending on its own in
          about {minutes} minutes. Pick the kind of conversation you need today.
        </p>
      </header>

      <div className="scenarios">
        {scenarios.map((scenario) => (
          <section key={scenario.slug} className="scenario">
            <div className="about">
              <h2 className="jp">{scenario.title}</h2>
              <p className="jp">{scenario.blurb}</p>
              <ol className="scenes">
                {scenario.sprints.map((sprint) => (
                  <li key={sprint.slug}>
                    <span className="jp">{sprint.persona}</span>
                    <span className="jp goal">{sprint.goal}</span>
                  </li>
                ))}
              </ol>
            </div>
            <button type="button" onClick={() => void start(scenario.slug)} disabled={starting !== null}>
              {starting === scenario.slug ? "Opening…" : "Start"}
            </button>
          </section>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
