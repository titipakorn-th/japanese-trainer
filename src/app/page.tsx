import { ScenarioPicker } from "@/client/ScenarioPicker";
import { listScenarios } from "@/server/scenarios";
import { pacing, sprintsPerSession } from "@/server/pacing";

/**
 * The scenarios are catalogued on the server and rendered here, so the learner
 * sees the real list and the real budgets rather than a copy the browser could
 * drift from. The shape of a session — how many scenes, how long in total — is
 * the same arithmetic the app uses to end one, so the promise on this screen is
 * the mechanism rather than a description of it.
 */
export default function StartPage() {
  const scenarios = listScenarios();
  const budgets = pacing();
  const sprints = sprintsPerSession(scenarios[0]?.sprints.length ?? 1);

  return (
    <ScenarioPicker
      scenarios={scenarios}
      sprints={sprints}
      minutes={Math.round(budgets.sessionMs / 60_000)}
      sprintMinutes={Math.round(budgets.sprintMs / 60_000)}
    />
  );
}
