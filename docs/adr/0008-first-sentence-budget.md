# 8. The first-sentence budget is 1.5s, and the original target was a guess

Date: 2026-10-01
Status: accepted

Numbered after 0007, which landed in the same session. This supersedes the
budget figure stated in ADR 0001 — not its model choice, which stands.

## Context

Issue #12 asked for a decision the design had deferred: what to hold the
partner's first sentence to. The spec states the budget as "~700–900ms" and
justifies it as "the single most important latency decision in the design",
because "conversation feels broken past roughly 500ms, so this number decides
whether the product works at all."

That number was written against `M2-her`, which does not exist on this account
(ADR 0001). No model available here reaches it. The budget was therefore never
a property of the product — it was a guess about a model that was never
available to run, and the product has been shipping against it ever since,
with a chip in the header quietly flagging most turns as over budget.

ADR 0001 chose the model and said, in its Consequences, that "latency sits at
the budget, not comfortably inside it: 0.8–1.6s against a 0.9s target." It left
the target alone. The model decision was made; the number decision was never
made at all.

## What we measured

From issue #12, 2026-09-30, from this machine, `npm run probe:model` against
the sprint prompt, plus the latency chip during a real session.

| | first sentence (median) | min | max | replies with no prose |
|---|---|---|---|---|
| Sprint prompt, before `240303b` | 1375ms | 828ms | 1977ms | 2 of 7 |
| Sprint prompt, after `240303b` | 950ms | 777ms | 1963ms | 0 of 7 |
| ADR 0001, pre-sprint prompt | 0.8–1.6s | — | — | — |
| In the app, browser-measured | 1300–1835ms | — | — | — |

Two things in that table decide this ADR.

**The browser number is the one the budget is written against.** `useTurn.ts`
times from submit to the first sentence being complete *to read*, because the
server can only time to its own first terminator and that excludes the flush,
the trip to the browser and the paint. A budget that is not the browser number
is not a budget the learner experiences.

**A single measurement of this model is worth about ±400ms.** Two probe runs
that differed by one line of prompt produced medians of 1375ms and 950ms. The
950 is not evidence that the product meets a 900ms target; it is a sample from
a distribution whose median is somewhere near 1.2–1.4s and whose tail reaches
past 1.8s.

Prompt length is not the lever. The sprint prompt is 740–936 characters against
roughly 600 before, and prefill is paid on every turn — but moving 600
characters to 900 did not move a 1.4s first sentence to 0.9s. There is a fixed
cost in front of the first content token that is not prompt length.

**These numbers are not fresh.** The probe could not be re-run for this ADR, so
the table above is the 2026-09-30 measurement, not one taken today. That matters
in one specific place: ADR 0001's M2.x rows were measured against the
*pre-sprint* prompt, and the sprint prompt is longer, so the better models are
worse now than that table says, not better. Re-measuring them is a known open
gap, not a premise of this decision — every route to a stronger partner is
slower than the one we are on, which is the only fact this ADR needs.

## Decision

**The budget is 1500ms, measured in the browser, and `BUDGET_MS` moves with it.**

`abab6.5s-chat` stays. ADR 0001's model choice is not revisited here: the
latency-versus-quality trade has been made, on the record, and the quality half
of it is a standing cost rather than a solved problem.

The budget moves because the old number described a model that does not exist,
not because 1.5s is fast. It is stated as what the partner actually does, so
that a turn at 1600ms reads as a miss against a real target instead of a
routine occurrence against an unreachable one.

The 500ms figure is withdrawn as a target. Nothing on this account reaches it.
Streaming is what makes 1.5s tolerable at all: without it the learner would
wait for the whole reply, not just its first sentence.

## Consequences

- **The chip means something again.** `BUDGET_MS` moves from 900 to 1500 so the
  over-budget flag in the header and the rail are measured against the number in
  the spec. A median turn now passes and a slow one is told the truth, which is
  the whole point of the second half of #12's done bar.
- **The partner is still weak, and that is the standing cost.** `abab6.5s-chat`
  misreads the learner sometimes and its quiet correction appears
  intermittently (ADR 0001, ADR 0002). Moving the line did not fix that and was
  not meant to. The product is faster than it would be on a reasoning model and
  worse at Japanese; that is the trade, now written down.
- **The prompt-trimming trade is retired.** Issue #12 left open whether to cut
  the worked example's JSON block, which is the largest removable chunk of the
  prompt and also what keeps the metadata block reliable. At a 1.5s budget that
  trade buys nothing worth the reliability it costs, so it is off the table. The
  block stays.
- **Do not re-derive the number from one session.** A single run is worth
  ±400ms. If this ADR is revisited, it takes a probe run and the in-app number,
  not one conversation that felt slow.
- **The latency budget is no longer the product's largest risk.** It was the
  largest while the target was unreachable and unexamined. It is now a known
  number with a known partner, and ADR 0001's standing instruction — re-probe
  and switch if a non-reasoning model with better Japanese appears — is what
  should move this, not a new opinion about the figure.

## Rejected

- **Holding 900ms as the stated target.** Nothing changes in the app and the
  spec keeps promising what the product has never delivered. The header chip
  flags most turns, which makes the number theatre: a budget that is always
  missed teaches the reader to ignore it.
- **Splitting the turn — a fast model speaks, a strong one annotates.** The only
  route to a partner that does not misread the learner, and not taken here. It
  doubles the calls per turn, and the annotations are what gate the inline
  markers (ADR 0002), so a late or failed second call has a visible failure mode
  that does not exist today. It stays available; it is a build, not a retune.
- **The M2.x models.** 2.0–3.4s on the shorter prompt in ADR 0001, and 7–16s on
  the longer one. The models that are better at the job are the ones furthest
  from the number, which is the trade ADR 0001 already took the other side of.
- **Re-running the probe first.** Preferred, and not possible in the session
  that wrote this ADR — the probe command could not be run, three times. The
  decision is made on the measurements already in issue #12 rather than on
  fresh ones, and says so above. This is the one part of #12's question this ADR
  does not close, and the gap is a re-measured catalog comparison, not a
  disputed figure.
