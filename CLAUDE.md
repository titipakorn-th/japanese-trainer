# japanese-trainer

A Japanese conversation trainer for a single learner (N4–N3) practising real-life
speaking scenarios. See `docs/superpowers/specs/` for design specs and
`prototype/` for throwaway UI explorations.

## Running it

```sh
cp .env.example .env.local   # then add MINIMAX_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm start`,
`npm run probe:model` — which streams real replies through the production prompt
and prints first-sentence timings, so the latency budget can be re-checked against
whatever models are available (see `docs/adr/0001-conversation-partner-model.md`) —
`npm run probe:tts` — which speaks every scenario line through the real voice
service and prints cold/warm timings, the MP3 header, the timed-word count and the
billable characters. See `docs/adr/0007-partner-speech.md` — and
`npm run probe:migrate` — which races a dozen cold starts against one fresh store and
checks the schema they leave. See `docs/adr/0009-cold-start-migration.md` — and
`npm run probe:cold-start`, which walks the path from tapping Start to a
readable first line against a running server and prints the breakdown against the
ten-second budget. Point it at a throwaway store so probing does not litter the
learner's history:

```sh
DATABASE_FILE=probe.db npm start &
npm run probe:cold-start
```

Point `MOCK_MODEL_URL` at a local endpoint to exercise the model failure and
timeout paths without spending a model call. `MOCK_TTS_URL` does the same for the
voice service, without spending characters.

## Architecture

The server owns a session. The client renders a projection of it and is never the
source of truth, so a reload resumes and a failed model call cannot lose the thread.
A learner's turn and the partner's reply commit in one transaction, or not at all.
See `docs/adr/0003-turn-atomicity.md`.

Anything the learner reads *about* a session is a projection of committed state
rather than a second read. The end-of-session summary is a pure function in
`src/lib/summary.ts` over the turns, sprints and fumbles the client already has,
so a live session ending and a reload of a finished one produce the same account
by the same code — see `docs/adr/0011-session-summary-projection.md`. If you find
yourself wanting a `/summary` endpoint, that is the decision being re-litigated.

## Never cache a conversation

The service worker exists so the app can be installed to a home screen. It caches
build output and nothing else: `/api/*` and `/session/*` are live server state
and are never served from a cache, and navigations are network-first with an
offline notice as the only fallback. A cached transcript is a screenshot of a
conversation rather than the conversation, and the learner cannot tell the
difference. See `docs/adr/0012-pwa-installability.md`.

## Measured numbers are claims with expiry

Two budgets in this app are written down, and neither stays true on its own:
first-sentence latency (900ms, ADR 0001) and cold start (10s, issue #11). Both
have a probe. Re-run the relevant one when the prompt, the model, the catalog, or
the route tree changes — a budget nobody measures is a budget that has quietly
stopped being true.

## The summary must not flatter the learner

`src/lib/summary.ts` is the one screen a learner is most likely to believe, so its
tests are mostly about what it refuses to say: a trend needs four measured turns
*and* a two-second gap, an unmeasured turn stays visible but out of every average,
and a walk-away is a ratio only once the sample can carry one. Those two
thresholds are copied from the debrief's `trend()` on purpose, so the sprint card
and the session summary cannot disagree about whether a learner sped up. If you
relax one, change both, and say why in the commit.

## Detection prompts are silent-regression hazards

The fumble detection prompt in `src/server/prompt.ts` is the load-bearing piece of
the project: a regression there is invisible to the conversation itself while the
Fumble Deck silently stops filling. There are no automated tests for detection.

Whenever `src/server/prompt.ts` is touched — the worked example, the fumble
instructions, the markers block — drive the app, type a deliberately bad turn, and
confirm the deck count on the coach rail went up. A deck that stopped growing is a
regression even when nothing else looks broken.

## The voice call is a silent-regression hazard

The same shape of risk, one layer over. `src/server/tts.ts` parses a third-party
response whose contract is mostly undocumented, and every one of its three known
traps fails *quietly* rather than throwing: a failed call still returns HTTP 200
with the status in `base_resp.status_code`; the audio is hex, not base64; and the
subtitle payload is a signed URL that dies in 24 hours. A response-shape change
upstream makes the play button stop making sound while the rest of the app looks
perfect.

So after touching `src/server/tts.ts`, run `npm run probe:tts`. It prints one line
per utterance plus the MP3 magic and the timed-word count, which is what a shape
change actually moves. Treat `NOT AN MP3`, a zero word count, or a line reading
`line(s) cached WITHOUT usable subtitle timings` as a regression. It costs about
650 billable characters, so it is a deliberate expense rather than a free check.

Confirm in the browser too: a partner turn shows a quiet `▶` beside its
PARTNER label, tapping it plays, tapping a second line stops the first, and
killing `MOCK_TTS_URL`'s target shows "No audio" briefly and leaves the
conversation intact.
## A cold build migrates the store from every worker at once
`next build` collects page data with a pool of workers, and each one imports
`src/server/db.ts`, which opens the store and migrates it at module scope. So the
first build in a fresh clone — the first thing a new contributor ever runs — is a
dozen processes creating and migrating the same file at the same instant.
Everything in `open()` therefore runs under contention, and two of the statements
there fail *differently and for unrelated reasons*, which is what makes this
worth knowing about:
- `migrate()` read the column list and then `ALTER`ed it, outside any lock. Two
  workers could both decide `turn.sprint_id` was missing; the loser died with
  `duplicate column name: sprint_id`. It is now one `IMMEDIATE` transaction, so
  the re-read happens under the write lock that guards the `ALTER`. Keep it that
  way: any new migration is still a check-then-act, and a deferred transaction
  would reintroduce this exactly.
- `PRAGMA journal_mode = WAL` **cannot** be fixed with a busy timeout. Changing
  journal mode needs an exclusive lock, and SQLite returns `SQLITE_BUSY` for it
  without consulting the busy handler — measured at 0ms against a held write
  lock. `enableWal` resolves it by re-reading instead, which works only because
  WAL is set *before* the write lock is taken, so a blocked worker finds the store
  already in WAL. Reorder those two steps and the re-read stops being sound.
Both surface as a build that fails during page-data collection, on the first build
in a fresh clone, and with an error that reads as a schema bug rather than a race
— so the cause is easy to misattribute to the schema. The window is narrow: a
handful of failures in a hundred cold starts, and it does not reproduce at all
once the file exists.
After touching `src/server/db.ts`, run `npm run probe:migrate`. It releases N
processes against one fresh store on a shared clock and reports each death, split
into `duplicate column` (the check-then-act is not atomic) and `lock` (the write
lock is not being waited on) because the two need opposite fixes. It also reads
the store back and fails on a missing column, which catches a migration that
opens without migrating. It costs nothing and touches only scratch files.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `github.com/titipakorn-th/japanese-trainer`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
