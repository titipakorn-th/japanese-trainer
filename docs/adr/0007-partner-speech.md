# 7. The partner speaks on demand, off the turn path

Date: 2026-10-01
Status: accepted

## Context

The spec (`docs/superpowers/specs/2026-09-29-japanese-conversation-trainer.md:186`) deferred text-to-speech, having specified and prototyped it first, and recorded why it was worth resurrecting: MiniMax's `t2a_v2` returns **word-level timestamps** alongside the audio, and those timestamps are what a listening-speed trainer would be built on. The spec was explicit that failure mode 1 — hearing the partner at native speed — stayed unsolved until this was picked up, and that everything else in the document should be read as solving three of the four problems.

This is that picking-up. It is a smaller thing than the spec's own description implies, and three questions had to be answered before any code:

**Where does synthesis run relative to the turn?** The answer turns on a fact about `runTurn` that is easy to miss: `commitExchange` runs at `src/server/turn.ts:365` and the `catch` that emits `{t:"error"}` is at `:551`. The catch is *downstream of the commit*. So any TTS call placed inside that `try` reports a failed turn for a turn already on disk, `useTurn` never pushes it into `committed`, the learner's draft comes back, and the retry appends a **second** turn because `nextSeq` has already moved. That is a data-corruption path, not a slow one.

**What does the API actually do?** Reading the docs was not enough; three properties are undocumented or actively misleading, and each one produces a silent failure rather than an error:

- **A failed call still returns HTTP 200.** The status lives in `base_resp.status_code`. A client that branches on the HTTP status treats every failure — a bad key, a bad voice id, a bad `emotion` — as a success and hands the browser a body with no audio in it.
- **`data.audio` is hex, not base64.** `Buffer.from(audio, "hex")`.
- **The subtitle payload is a signed URL that expires in 24 hours.** Caching that URL is caching a reference to nothing a week later, which is precisely the failure the spec warned about at `:192` when it said the cached value must be the audio *plus* the subtitle payload.

And one gap in the API itself: **`speed` is not validated server-side.** An out-of-range value is synthesised without complaint, so the client is the only place it can be caught.

**What is pre-warmed?** The spec assumed a large fixed utterance set — greetings, scenario framing, sign-offs — that would earn the cache its keep. In this codebase that set does not exist. `openingLine` and `closingLine` in `scenarios.ts` are *prompt examples* fed to the model (`prompt.ts:164-165`); the model writes the line the learner hears, and the client never renders the example. The only templated partner utterance in the app is the drill cue (`turn.ts:164`). So the cache's hit rate comes almost entirely from replays, not from a pre-warm, and the pre-warm idea is deferred along with karaoke rather than built on a premise that turned out to be wrong.

## What we measured

`npm run probe:tts` speaks all 30 opening/closing lines across the three scenarios plus a drill cue, then replays each one. This is the real corpus, not a sample, because its length distribution is what decides whether synthesis feels immediate.

| Measure | Value |
|---|---|
| Cold synthesis, median | **1263ms** (first call 2940ms, cold connection) |
| Warm replay, median | **0–1ms** |
| Audio per line, median | 2772ms of speech, ~46kb |
| 31 lines on disk | 1.43mb |
| Billable | 657 characters for 31 lines |
| Timed words captured | 611, per-mora for Japanese (`じゃあ` → 3 entries) |
| MP3 validity | `49443304` = `ID3\x04` ID3 tag, confirmed on every path |

The gap between 1263ms and 0ms is the entire argument for the cache. Cold is well inside what a learner will tolerate from a deliberate tap; warm is free.

The spec's size estimate at `:192` was low by about 3×: it guessed 3mb per session at 200 unique lines, and the measured figure is ~46kb per line, so a full session is nearer 9mb. At the 256mb default that is about 28 sessions of history before eviction starts.

## Decision

**Speech is a pure function of a line's text, so it is synthesised on demand from the client, behind a button, and it never touches the turn pipeline.**

### Off the turn path

Synthesis is called from `POST /api/tts` with a body of `{ text }` and nothing else. It is structurally incapable of reaching a turn: it holds no session id, imports no session code, and runs after the response that committed the turn is already on the wire. This is the same reason `commitExchange`, `commitBoundary` and `commitDrillResponse` are untouched by this change — per ADR 0003 they are the atomicity boundary, and anything that can do I/O inside a `better-sqlite3` transaction holds a write lock for the duration.

The alternative — pre-synthesising server-side just after the commit — is defensible and was the runner-up, but the only safe insertion point is `turns/route.ts`'s `finally`, which puts an external call inside the turn's lifetime for a benefit nobody asked for. The learner is tapping a button; they are already waiting.

### The route is not session-scoped

`POST /api/tts`, not `POST /api/sessions/[id]/tts`. The audio depends on the text and the voice settings, so scoping it to a session would couple speech to a session's lifecycle for no gain and would inherit the 404-on-ended overload the other session routes use — a line from a session that has ended would refuse to play. The client treats any non-200 as "no audio" and says nothing.

### Playback is button-gated everywhere

No autoplay, on any platform. iOS would not permit it for the opening line regardless, since that line fires from a `useEffect` with no user gesture behind it — so autoplay would work on the Mac and silently fail on the phone, which is the worst version of the feature. A global mute would also put the partner's voice in competition with OS dictation, the hazard the spec already named when it rejected a custom STT pipeline at `:196`. One line plays at a time: tapping a new line stops the old one, which is why the buttons share a module-level `stopCurrent` rather than each keeping its own state.

### Synthesis is not streamed

`stream: false`, and the whole MP3 is returned. Streaming measures better — roughly 640ms to first audio against ~1234ms for the whole line — and it is the obvious future move, but the cache has to store a complete file, so streaming would mean buffering anyway. The final `status: 2` frame also re-sends the complete audio re-encoded with a fresh ID3 tag, so concatenating the streamed chunks and taking the aggregate are two different files, and a client that does both plays the line twice. Not worth the ambiguity for a button the learner pressed deliberately.

### The cache holds two files per line, and only one of them is used

Key: `sha256(JSON([VoiceSettings, text]))`. Value: the MP3 plus a JSON sidecar holding the resolved subtitle segments with their per-word timings. The key hashes the *settings* rather than a version number, so changing `TTS_SPEED` or `TTS_VOICE_ID` invalidates exactly the affected entries with no manual purge — a version constant is a thing to forget to bump.

**The sidecar is currently read by nothing.** That is deliberate and it is the spec's `:192` requirement taken literally: the subtitles are fetched during synthesis, while the signed URL is still live, and stored forever, so that building karaoke highlighting later costs no characters. Caching only the audio would mean re-billing every line in the learner's history the day that feature lands.

Entries are written through a temporary name and renamed into place, because a crash part-way through a direct write leaves a truncated MP3 that reads as a hit forever after. A read touches the file's mtime, so least-recently-used and oldest-mtime are the same thing and eviction needs no access log.

### Three things are clamped, translated, or forced at the boundary

Speed, volume and pitch are clamped to the documented ranges locally, because the service accepts out-of-range values silently. The subtitle wire format is snake_case and is translated to camelCase in exactly one place (`resolveSubtitles`): reading `timeBegin` off a `time_begin` payload type-checks fine and yields `undefined`, which drops every segment on the floor with no error anywhere. This was a real bug, caught by the probe's word count reading zero, and it is the exact data the cache exists to preserve.

## Consequences

- **TTS cannot break a conversation, and that is the point.** The feature has no write path. A learner whose key expired, whose voice id was renamed upstream, or whose network is down loses audio and nothing else — verified by driving the app with the route returning 503: the button reads "No audio" for a moment, returns to idle, and all three turns stay in the transcript.
- **Turning latency is unchanged.** Nothing in the TTS path runs during a turn, so the first-sentence budget in ADR 0008 is untouched and the Fumble Deck cannot be affected by anything here. "Unchanged" is about the turn, not about the process: a cache read is a synchronous `readFileSync` plus two `utimesSync` calls, and a cache write ends in a synchronous directory scan, both on the same event loop the turn runs on. That is a few milliseconds against a directory of a few hundred entries, and it is the price of not holding audio in memory.
- **A lost subtitle fetch is recorded, not hidden.** `resolveSubtitles` swallows its own failures by design — the audio is already paid for — but the sidecar stores `subtitlesResolved`, so a line whose timings were lost once is distinguishable from a line that has none. Without it, the cache key (text and settings, which know nothing went wrong) would have frozen that empty result permanently and karaoke would have been missing those lines forever, with no way to tell why.
- **What fails silently: a change in the upstream response shape.** If MiniMax renames a field, this button quietly stops making sound and the rest of the app looks perfect — the same failure shape as the fumble deck going quiet, which the spec's Testing Decisions section flags as the accepted cost of having no test suite. `npm run probe:tts` is the guard: it prints a line per utterance, the MP3 magic, and the timed-word count, so a shape change shows up as `magic: NOT AN MP3`, a zero word count, or a wall of FAILs rather than as a subtly wrong voice. Run it after anything touches `tts.ts`. It is worth about 650 billable characters.
- **One byte-level check exists because nothing else would catch it.** The probe asserts the MP3 header, after a first version of that check compared four bytes against the three of `"ID3"` and reported a perfectly good file as broken. A check that cannot fail correctly is worse than no check.
- **Karaoke highlighting is now a rendering problem, not a data problem.** The per-mora timings are on disk for every line ever spoken. The remaining work is threading a "currently speaking" index into the bubble, and `AnnotatedText` has no notion of one — it segments by marker offsets only, and it carries a private copy of the furigana renderer that `src/client/Furigana.tsx` was apparently written to consolidate.
- **A client-side URL cache of six entries sits in front of the disk cache.** Replaying a line the learner just heard is instant and costs no round trip. It is bounded, and eviction revokes.
- **The cache is not shared between learners**, which is currently a non-issue: there is one learner, and the app has no accounts.
- **No service worker, so no offline audio and no installable PWA.** The spec requires PWA installability at `:116` and it remains entirely unimplemented; this change does not attempt it and should not be read as moving toward it.

## What this leaves undone

Stated plainly, because the narrowing was agreed before the code was written and these are the parts of the spec's design that did not survive it:

- **The fixed utterance set is not pre-warmed.** The spec's `:192` asks for it, and names that layer as "the layer that must never stutter." The premise does not hold in this codebase — the fixed strings do not exist, as recorded in Context — but the conclusion is still partly right: the drill cue is templated rather than model-written, and it cold-synthesises at ~1.2s on its first use in a session. Warming the current deck's drill lines at session start would close this, and is the cheapest remaining win.
- **No pause markers.** The spec's `:191` wants a partner who "hesitates and sounds flat or surprised rather than reading everything in monotone", and `<#x#>` is the mechanism. Nothing inserts one, so speech is one continuous phrase per turn — which is measurably harder to transcribe by ear than the same line with a comma's worth of pause.
- **Emotion is process-wide, not per-persona.** `TTS_EMOTION` is one value for the whole app, and the default voice is an izakaya counter applied to all three scenarios. The spec frames these as properties of the partner, and one day they should come from the scenario rather than the environment.
- **No streaming**, as argued above: ~640ms to first audio against ~1263ms for the whole line. The latency is real and paid on every first hearing of a line.
- **The debrief's partner lines have no play button.** `DebriefCard.tsx:36` renders text and is outside the transcript loop, so the lines in a debrief cannot be heard.
- **Nothing is ever retried.** `retryable` is computed and returned but the client shows the same "No audio" for a rate limit as for a revoked key, and gives the learner no second attempt.

## Rejected

- **Synthesising inside `runTurn`'s `try`.** The catch block sits after `commitExchange` (`turn.ts:365` then `:551`), so a TTS failure there reports a failed turn for a turn already written, and the learner's retry appends a duplicate. Same atomicity argument as a mid-scene reply in `turn.ts:382-387`.
- **Pre-synthesising server-side after the commit.** Defensible, and it would make the first tap instant. It puts a ~1.2s external call inside the turn's lifetime at the cost of a round trip nobody asked for, and it puts a second failure mode in the one code path this project cannot afford to make flakier.
- **A `tts_cache` table in SQLite.** One store for everything and eviction is a `DELETE`, but the spec asked for disk so the cache survives a database reset, and blobs in the session database make every session query carry audio it never reads.
- **Storing the cache under `data/`.** `data/` is ignored by extension, not by directory — only `*.db` is ignored — so MP3s written there are committed by the next `git add -A`. `.gitignore:26` already reserved a top-level `.tts-cache/` for this, and that is where it lives.
- **Caching the subtitle URL instead of its contents.** It works today and breaks next week, and it would break in the least noticeable way available: karaoke silently rendering nothing for historical turns.
- **Autoplay after the first gesture, with a mute toggle.** Better immersion on the Mac, and the opening line still silent on iOS, which is the part a learner would file as a bug.
- **The browser's own `speechSynthesis` with a system Japanese voice.** No characters billed, but no per-word timings, no consistent voice across devices, and the quality is whatever the learner's OS happens to ship. The whole reason for MiniMax is the subtitle payload.
