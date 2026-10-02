import { firstSentenceEnd } from "@/lib/sentences";
import { performance } from "node:perf_hooks";

/**
 * Measure what the learner waits for between tapping Start and being able to read
 * the partner's first line.
 *
 * Issue #11 promises a session starts in under ten seconds from a cold load, and
 * a budget nobody measures is a budget that quietly stops being true. This walks
 * the path the browser does, against a real server, and prints where the time
 * went: fetching the JavaScript the session page needs, creating the session and
 * writing its plan, rendering the page the router pushes to, and streaming the
 * opening line.
 *
 * The bundle is timed and counted, not mentioned in a footnote. It is the largest
 * and most variable of those terms, and a total that left it out would report
 * "inside the budget" for a build that blows ten seconds the moment a route grows
 * — the budget would be satisfied by a number that was never the learner's.
 *
 * What this still cannot see, stated plainly so the total is not read as more
 * than it is: parsing and hydrating that JavaScript. A script that fetched the
 * page cannot execute it, so the render and hydration cost is excluded and the
 * total is a lower bound on the real one. What remains — transfer, server work,
 * and the model call — is the part that moves when this app changes. The number
 * to trust for the full path is the one measured in a browser.
 *
 * Point it at a server started against a throwaway store, so probing does not
 * litter the learner's own history:
 *
 * ```sh
 * DATABASE_FILE=probe.db npm start &
 * npm run probe:cold-start
 * ```
 */

/** The budget the issue sets, in ms. */
const BUDGET_MS = 10_000;

const BASE = (process.env.PROBE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SCENARIO = process.env.PROBE_SCENARIO || "izakaya";

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ value: T; took: number }> {
  const t0 = performance.now();
  const value = await run();
  const took = performance.now() - t0;
  console.log(`  ${label.padEnd(34)} ${ms(took)}`);
  return { value, took };
}

console.log(`cold start against ${BASE}\n`);

const created = await timed("POST /api/sessions", async () => {
  const response = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: SCENARIO }),
  });
  if (!response.ok) throw new Error(`start failed: HTTP ${response.status}`);
  return (await response.json()) as { id: string };
});

const page = await timed("GET /session/:id (html)", async () => {
  const response = await fetch(`${BASE}/session/${created.value.id}`);
  if (!response.ok) throw new Error(`page failed: HTTP ${response.status}`);
  return await response.text();
});

// The scripts the page will make the browser download before it can fire the
// opening turn. Timed, and counted in the total — see the note at the top for
// why a footnote would not do.
//
// Measured by reading the bodies rather than by `content-length`: the build
// server answers with a compressed, chunked response, so the header is absent
// and would report zero. `fetch` hands back the decompressed bytes, which is the
// larger and more conservative of the two numbers.
let bundleBytes = 0;
const bundle = await timed("js for the session page", async () => {
  const urls = [
    ...new Set(
      [...page.value.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]!),
    ),
  ];
  await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(`${BASE}${url}`);
      if (res.ok) bundleBytes += (await res.arrayBuffer()).byteLength;
    }),
  );
  return urls.length;
});

// The clock the streaming callback reads: the moment the request went out, not
// the moment this script reached the loop.
const startedAt = performance.now();

const opening = await timed("POST turns (first sentence)", async () => {
  const response = await fetch(`${BASE}/api/sessions/${created.value.id}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: null, responseMs: null }),
  });
  if (!response.ok || !response.body) throw new Error(`turns failed: HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shown = "";
  let first = 0;
  let outcome = "no prose in the reply";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.t === "delta") {
        shown += String(event.v);
        if (!first && firstSentenceEnd(shown) > 0) {
          first = performance.now() - startedAt;
        }
      } else if (event.t === "reset") {
        shown = "";
      } else if (event.t === "error") {
        outcome = `error: ${String(event.message)}`;
      } else if (event.t === "done") {
        outcome = "committed";
        if (!first) first = performance.now() - startedAt;
      }
    }
  }
  return { first, outcome };
});

// The bundle is in the total. A budget checked against the server path alone
// would be satisfied by a build whose JavaScript alone took twelve seconds to
// arrive, and the number would be nothing the learner ever experiences.
const total = bundle.took + created.took + page.took + opening.took;

console.log(
  `\n  ${"of which, js transferred".padEnd(34)} ${(bundleBytes / 1024).toFixed(0)}KB ` +
    `in ${bundle.value} files`,
);
console.log(`  ${"first sentence".padEnd(34)} ${ms(opening.value.first)}`);
console.log(`  ${"outcome".padEnd(34)} ${opening.value.outcome}`);

console.log(
  `\n  start → first line: ${ms(total)} against a ${ms(BUDGET_MS)} budget — ` +
    (total <= BUDGET_MS ? "inside it" : "OVER BY " + ms(total - BUDGET_MS)),
);
console.log(`  (parse and hydrate are still excluded, so this is a lower bound; see the top of this file)`);

if (opening.value.outcome !== "committed") {
  console.log("  the opening did not commit, so the figure above is not a real start");
  process.exitCode = 1;
}
