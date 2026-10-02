import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Check that the reading aid keeps its state on the server, and keeps one renderer.
 *
 * Both of these have now regressed at least once in a way that nothing noticed.
 *
 * The reveal set was sessionStorage. `PATCH /api/sessions/[id]/revealed` had no
 * caller, so `addRevealedReading()`, the `revealed_readings` column and the
 * `revealedReadings` field were all unreachable — and a reveal died with the tab
 * rather than lasting "the rest of the Session" as the acceptance criterion
 * says. That shipped behind a closing comment reporting all eight criteria
 * ticked, because the only test of it had hit the route directly rather than
 * the client path, so it passed against a code path no user ever took.
 *
 * The renderer had three copies of the same decision tree, one of them
 * imported by nothing. `StreamedText` was also called with no props at all, so
 * an in-flight turn rendered with the toggle forced off and every hard word a
 * dead tap target. The optional props were what hid that: making them required
 * is what surfaced it.
 *
 * A seam note, because it limits what this can honestly claim. The first fault
 * was in the browser, so a server-only test would have passed throughout — the
 * endpoint works perfectly well when nobody calls it. Half of this probe is
 * therefore structural: it reads the client source and asserts the invariants
 * that were broken. That is weak, and it is weak knowingly; it catches these
 * two regressions, which were both structural, and it will not catch a client
 * that calls the endpoint in a way that never round-trips. The other half does
 * exercise the real server functions against a scratch store.
 *
 * Costs nothing, spends no model call, and touches only its own scratch file.
 */

const NAME = `reading-aid-probe-${process.pid}.db`;
const CLIENT = path.join(process.cwd(), "src", "client");
const store = (suffix = "") => path.join(process.cwd(), "data", NAME + suffix);
for (const suffix of ["", "-wal", "-shm"]) rmSync(store(suffix), { force: true });

// db.ts opens the store at module scope, so the scratch name has to be in the
// environment before anything in the graph that reaches it is imported.
process.env.DATABASE_FILE = NAME;

const { default: Database } = await import("better-sqlite3");
const { createSession, getSession, addRevealedReading, setSessionFurigana } = await import(
  "@/server/sessions"
);

const problems: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const read = (file: string) => readFileSync(path.join(CLIENT, file), "utf8");
const exists = (file: string) => {
  try {
    readFileSync(path.join(CLIENT, file));
    return true;
  } catch {
    return false;
  }
};

console.log();
console.log("server");
{
  const db = new Database(store());
  const cols = (db.prepare("PRAGMA table_info(session)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  check(cols.includes("revealed_readings"), "session.revealed_readings exists");
  check(cols.includes("furigana_on"), "session.furigana_on exists");
}

{
  const session = createSession();
  check(session.furiganaOn === false, "a new session starts with furigana off");
  check(session.revealedReadings.length === 0, "a new session starts with nothing revealed");

  // The round trip that the original smoke test never made: a reveal has to
  // come back on a *fresh read*, not out of the object that was just written.
  addRevealedReading(session.id, "大丈夫");
  addRevealedReading(session.id, "辛い");
  const after = getSession(session.id);
  const revealed = after?.revealedReadings ?? [];
  check(
    revealed.length === 2 && revealed.includes("大丈夫") && revealed.includes("辛い"),
    "two reveals survive a fresh read",
    JSON.stringify(revealed),
  );

  addRevealedReading(session.id, "大丈夫");
  check(getSession(session.id)?.revealedReadings.length === 2, "re-revealing the same word does not duplicate it");

  setSessionFurigana(session.id, true);
  check(getSession(session.id)?.furiganaOn === true, "the toggle survives a fresh read");
}

console.log();
console.log("client");
{
  const view = read("SessionView.tsx");

  // The invariant, not the implementation: reveal state is server-owned, so it
  // has no business in browser storage. This is the check that would have
  // failed on the day the closing comment said it was done.
  check(!/sessionStorage|localStorage/.test(view), "SessionView keeps no reveal state in browser storage");
  check(/\/revealed/.test(view), "SessionView calls the /revealed endpoint");

  const stream = read("StreamedText.tsx");
  const annotated = read("AnnotatedText.tsx");
  check(exists("Furigana.tsx"), "the shared renderer exists");
  check(
    stream.includes('from "./Furigana"') && annotated.includes('from "./Furigana"'),
    "both render paths import the shared renderer",
  );

  const definitions = ["Furigana.tsx", "AnnotatedText.tsx", "StreamedText.tsx"].filter((f) =>
    /function (FuriganaSpan|KanjiTap|Furigana)\b/.test(read(f)),
  );
  check(
    definitions.length === 1 && definitions[0] === "Furigana.tsx",
    "exactly one file defines the renderer",
    definitions.join(", "),
  );

  // The dead tap target. `<StreamedText text={stream} />` is the shape that let
  // an in-flight turn render every hard word as a button wired to nothing.
  const tag = view.match(/<StreamedText[\s\S]*?\/>/)?.[0] ?? "";
  check(
    tag.length > 0 && /furiganaOn/.test(tag) && /onReveal/.test(tag),
    "the streaming path receives the furigana props",
    tag.length === 0 ? "no <StreamedText/> call site found" : "",
  );
}

for (const suffix of ["", "-wal", "-shm"]) rmSync(store(suffix), { force: true });

console.log();
if (problems.length) {
  console.log(`${problems.length} problem(s): ${problems.join("; ")}`);
  if (problems.some((p) => p.includes("browser storage") || p.includes("endpoint"))) {
    console.log(
      `\nA reveal that never reaches the server is the #9 failure. If the client is holding the\n` +
        `set locally, the endpoint, the column and addRevealedReading() are all dead code and a\n` +
        `reveal dies with the tab.`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("result:  reveal state is server-owned and one renderer draws it");
}
