import { ScenarioPicker } from "@/client/ScenarioPicker";
import { listScenarios } from "@/server/scenarios";
import { pacing, sprintsPerSession } from "@/server/pacing";
import { startStats } from "@/server/stats";

/**
 * This screen is rendered per request, never at build time.
 *
 * Nothing here says "static", but the page is a plain synchronous server
 * component, so Next prerenders it — and a prerendered start screen freezes the
 * two numbers the learner reads to decide what they are walking into. A learner
 * who worked through the deck and came back would be told the deck was empty,
 * because the copy on the server was written once when the image was built. The
 * numbers are the whole point of putting them on this screen, so they have to be
 * read when the screen is.
 */
export const dynamic = "force-dynamic";

/**
 * The scenarios are catalogued on the server and rendered here, so the learner
 * sees the real list and the real budgets rather than a copy the browser could
 * drift from. The shape of a session — how many scenes, how long in total — is
 * the same arithmetic the app uses to end one, so the promise on this screen is
 * the mechanism rather than a description of it.
 *
 * The state the learner is walking into travels with it: the size of the deck
 * waiting to be worked through, and what the last finished sitting actually met.
 */
export default function StartPage() {
  const scenarios = listScenarios();
  const budgets = pacing();
  const sprints = sprintsPerSession(scenarios[0]?.sprints.length ?? 1);
  const stats = startStats();

  return (
    <ScenarioPicker
      scenarios={scenarios}
      sprints={sprints}
      minutes={Math.round(budgets.sessionMs / 60_000)}
      sprintMinutes={Math.round(budgets.sprintMs / 60_000)}
      deckSize={stats.deckSize}
      started={stats.started}
      last={stats.last}
    />
  );
}
