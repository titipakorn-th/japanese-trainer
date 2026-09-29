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
whatever models are available (see `docs/adr/0001-conversation-partner-model.md`).

Point `MOCK_MODEL_URL` at a local endpoint to exercise the failure and timeout paths
without spending a model call.

## Architecture

The server owns a session. The client renders a projection of it and is never the
source of truth, so a reload resumes and a failed model call cannot lose the thread.
A learner's turn and the partner's reply commit in one transaction, or not at all.
See `docs/adr/0003-turn-atomicity.md`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `github.com/titipakorn-th/japanese-trainer`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
