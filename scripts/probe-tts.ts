import { cacheStats, CACHE_DIR } from "@/server/ttsCache";
import { speak, synthesize, ttsTimeoutMs, TtsError, voiceSettings } from "@/server/tts";
import { SCENARIOS } from "@/server/scenarios";
import { loadSettings } from "./settings";
import { performance } from "node:perf_hooks";

/**
 * Speak real lines out loud and print what the voice feature actually costs.
 *
 * The corpus is the app's own text — the opening and closing lines of every
 * scenario, plus a drill line — because those are the strings the learner will
 * actually hear, and their length distribution is what decides whether synthesis
 * feels immediate. Synthesising a short sample would flatter the numbers.
 *
 * Two numbers matter and they are measured separately. A **cold** call pays for
 * the API; a **warm** call reads a file, and the gap between them is the whole
 * argument for the cache. The warm number is the one a learner feels on replay,
 * so if it ever stops being trivial the cache is broken.
 */

loadSettings();

const LINES: string[] = [];
for (const scenario of SCENARIOS) {
  for (const sprint of scenario.sprints) {
    LINES.push(sprint.openingLine, sprint.closingLine);
  }
}
LINES.push("あ、「-resources hungry」をじゃなくて、「resource hungry」ですね、もう一度お願いします。");

/** Cold synthesis is one tap and a wait; warm replay should be felt as instant. */
const COLD_BUDGET_MS = 2500;
const WARM_BUDGET_MS = 100;

const settings = voiceSettings();
console.log(`voice:  ${settings.voiceId}`);
console.log(`model:  ${settings.model}`);
console.log(`timbre: speed=${settings.speed} vol=${settings.volume} pitch=${settings.pitch} emotion=${settings.emotion ?? "auto"} lang=${settings.languageBoost}`);
console.log(`budget: cold ${COLD_BUDGET_MS}ms, warm ${WARM_BUDGET_MS}ms, timeout ${ttsTimeoutMs()}ms`);
console.log(`lines:  ${LINES.length}`);
console.log();

const cold: number[] = [];
const warm: number[] = [];
const lengths: number[] = [];
let charged = 0;
let cached = 0;
let words = 0;
let segments = 0;
/** Lines whose stored subtitle timings are missing — the karaoke-blocking case. */
let firstSubtitleGap = 0;
let failed = 0;

for (const text of LINES) {
  const t0 = performance.now();

  let first: Awaited<ReturnType<typeof speak>>;
  try {
    first = await speak(text, AbortSignal.timeout(ttsTimeoutMs()));
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${text.slice(0, 24)}  ${error instanceof TtsError ? `${error.statusCode} ${error.message}` : String(error)}`);
    continue;
  }
  const firstMs = performance.now() - t0;

  // The second call is the one a learner makes when they want to hear it again.
  const t1 = performance.now();
  const second = await speak(text, AbortSignal.timeout(ttsTimeoutMs()));
  const secondMs = performance.now() - t1;

  if (first.synthesized) {
    cold.push(firstMs);
    // Only a synthesis bills anything. Adding the stored `usageCharacters` back
    // on a cache hit would report the cost of the first run on every subsequent
    // one, which is the opposite of what the spec asked this number to be for.
    charged += first.usageCharacters;
  } else {
    cached++;
  }
  if (!second.synthesized) warm.push(secondMs);
  segments += first.subtitles.length;
  words += first.subtitles.reduce((n, segment) => n + segment.words.length, 0);
  if (!first.subtitlesResolved) firstSubtitleGap++;
  lengths.push(first.audioLengthMs);

  const mark = first.synthesized ? "cold" : "CACHED";
  const kind = firstMs > COLD_BUDGET_MS || secondMs > WARM_BUDGET_MS ? "over budget" : "";
  console.log(
    `  ${mark.padEnd(6)} ${String(firstMs.toFixed(0)).padStart(5)}ms -> ${secondMs.toFixed(0).padStart(4)}ms  ` +
      `audio=${(first.audio.length / 1024).toFixed(1)}kb/${first.audioLengthMs}ms  ` +
      `sub=${first.subtitles.length}seg/${first.subtitles.reduce((n, s) => n + s.words.length, 0)}w  ` +
      `charge=${first.usageCharacters}  ${kind}`,
  );
}

/**
 * The audio has to be a real MP3, and the only way to know is to look at the
 * bytes. A hex decode that silently produced garbage would still return 200 and
 * still be cached, and the learner would hear nothing at all.
 */
console.log();
const probe = await synthesize(LINES[0]!, settings, AbortSignal.timeout(ttsTimeoutMs()));
const magic = probe.audio.subarray(0, 4);
// Two signatures, both legitimate: an ID3 tag ("ID3" then a version byte), or a
// bare MPEG frame with its sync bits set. Comparing the whole four bytes to the
// three of "ID3" never matches, and would report a working file as broken.
const isMp3 =
  magic.subarray(0, 3).equals(Buffer.from("ID3")) || (magic[0] === 0xff && (magic[1]! & 0xe0) === 0xe0);
console.log(`magic:  ${magic.toString("hex")} ${isMp3 ? "(valid MP3)" : "(NOT AN MP3)"}`);
console.log(
  `cache:  ${segments} segments / ${words} timed words stored for these lines — the sidecars, not the URLs`,
);
console.log(
  `        ${firstSubtitleGap === 0 ? "every entry recorded its subtitles" : `${firstSubtitleGap} line(s) cached WITHOUT usable subtitle timings`}`,
);

/**
 * The subtitle payload arrives as a signed URL that expires in 24 hours. If the
 * sidecar on disk held a URL, karaoke would work today and break next week, so
 * the thing worth asserting is what actually got written.
 */
const stats = await cacheStats();
console.log(
  `disk:   ${stats.entries} entries, ${(stats.bytes / 1024 / 1024).toFixed(2)}mb of ${(stats.capBytes / 1024 / 1024).toFixed(0)}mb cap`,
);
console.log(`        ${stats.dir}${stats.dir === CACHE_DIR ? "" : ` (expected ${CACHE_DIR})`}`);

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
console.log();
console.log(`cold:   ${cold.length} synthesised, ${cached} already cached  median ${median(cold).toFixed(0)}ms`);
console.log(`warm:   ${warm.length} replays                             median ${median(warm).toFixed(0)}ms  (budget ${WARM_BUDGET_MS}ms)`);
console.log(`audio:  median ${median(lengths).toFixed(0)}ms of speech per line`);
console.log(`cost:   ${charged} billable characters across ${cold.length} synthesised lines`);

if (failed > 0) {
  console.log(`\n${failed} line(s) failed — check the key, the voice id, and the region host.`);
  process.exitCode = 1;
} else if (!isMp3) {
  console.log("\nSynthesis returned something that is not an MP3.");
  process.exitCode = 1;
}
