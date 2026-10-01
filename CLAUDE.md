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

Other scripts: `npm run typecheck`, `npm run build`, `npm start`, and
`npm run probe:model` — which streams real replies through the production prompt
and prints first-sentence timings, so the latency budget can be re-checked against
whatever models are available (see `docs/adr/0001-conversation-partner-model.md`) —
`npm run probe:tts` — which speaks every scenario line through the real voice
service and prints cold/warm timings, the MP3 header, the timed-word count and the
billable characters. See `docs/adr/0007-partner-speech.md`.

Point `MOCK_MODEL_URL` at a local endpoint to exercise the model failure and
timeout paths without spending a model call. `MOCK_TTS_URL` does the same for the
voice service, without spending characters.

## Architecture

The server owns a session. The client renders a projection of it and is never the
source of truth, so a reload resumes and a failed model call cannot lose the thread.
A learner's turn and the partner's reply commit in one transaction, or not at all.
See `docs/adr/0003-turn-atomicity.md`.

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

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `github.com/titipakorn-th/japanese-trainer`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
