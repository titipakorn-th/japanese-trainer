# 1. The conversation partner's model

Date: 2026-09-29
Status: accepted

## Context

The design in `docs/superpowers/specs/2026-09-29-japanese-conversation-trainer.md` makes the
model call the single largest technical risk in the product, and says so twice: the first
sentence of the partner's reply has to be on screen within 700–900ms of submitting a turn,
because "conversation feels broken past roughly 500ms, so this number decides whether the
product works at all."

The spec names MiniMax `M2-her`. **That model does not exist on this account.** The catalog
returned by `GET /v1/chat/completions` is `MiniMax-M3`, `M2.7`, `M2.5`, `M2.1`, `M2` and
their `-highspeed` variants. The spec's name is close to `M2-highspeed` and `M2-her`, both of
which return HTTP 400.

So the model had to be chosen by measurement rather than by the spec's name.

## What we measured

Measured from this machine against `api.minimaxi.com` (region `cn`), streaming, with the
production system prompt. "First sentence" is when a sentence terminator appears in the
stream, which is the moment the client renders the first sentence.

| Model | First sentence | Streams a metadata block | Fills the quiet correction |
|---|---|---|---|
| `abab6.5s-chat` | **0.8–1.6s** | always | intermittently |
| `MiniMax-M2.5-highspeed` | 2.0–3.3s | often omits it | yes |
| `MiniMax-M2.7-highspeed` | 2.2–3.4s | usually | yes |
| `MiniMax-M2.7-highspeed`, long prompt | 7–16s | usually | yes |

Every M2.x model reasons before it speaks. The thinking lands in `reasoning_content` only
when `reasoning_split: true` is set — without it a raw `<think>` block streams straight into
the first sentence the learner sees, which is why that flag is not optional. There is no
parameter that turns reasoning off: `thinking: {type: disabled}`, `reasoning_effort: none`,
`max_thinking_tokens: 0` and `thinking_budget: 0` were each tried and each still produced
thinking tokens.

There is a fixed prefill cost of roughly 1.8s on the smallest available model before the
first content token, so prompt length is paid twice: once in prefill, and again in how much
the model thinks about. The structured prompt this project needs pushed `M2.7-highspeed` from
2.2s to 7–16s.

## Decision

Default `MINIMAX_MODEL` to `abab6.5s-chat`.

It is the only model available that fits the latency budget, and the latency budget is the
product. The M2.x models are better Japanese and follow the output format more reliably, but
they miss the one number the design says decides whether the product works.

The model is an env var, not a hard-coded constant, because this decision is a latency-versus-
quality trade and not a settled question. `npm run probe:model` re-runs the comparison in
`scripts/probe-model.ts` so the numbers can be re-checked when the catalog changes.

## Consequences

- **The quiet correction is unreliable.** Asked for a `{"natural": "..."}` field, this model
  copies `{"natural": ""}` out of the prompt's own example and never fills it in. Asked for a
  line it should write after its reply, it complies. See ADR 0002. Even then it produces a
  correction only sometimes, and sometimes restates the partner's own line instead of
  rephrasing the learner. `parseReply` drops every case that is not a real correction.
- **Markers are reliable.** The fenced JSON block is produced on essentially every turn, with
  `surface` values that appear in the reply, so the character ranges resolve.
- **Latency sits at the budget, not comfortably inside it.** 0.8–1.6s against a 0.9s target,
  and the first turn of a fresh process is slower still while DNS and TLS warm up. The
  measured number is on screen in the header during every turn, and the session rail repeats
  it, so the budget is visible rather than assumed.
- **If a non-reasoning model with better Japanese becomes available, re-run the probe and
  switch.** Nothing in the architecture depends on which model is used.

## Rejected

- **`MiniMax-M2.7-highspeed`** as the default. Better at the job, 3–4x over budget on the
  real prompt, and it drops the metadata block often enough that the inline markers would
  stop rendering.
- **Two model calls per turn**, one for the line and one for the annotations. It would let a
  slow reasoning model annotate while a fast one speaks. It doubles cost and, for the
  annotations, doubles the time before anything is final — for a product whose entire premise
  is the first sentence arriving quickly.
- **Prefilling the opening line of a scene** to hide the cold start. It is a lie about what
  the partner said, and it only helps the first turn.
