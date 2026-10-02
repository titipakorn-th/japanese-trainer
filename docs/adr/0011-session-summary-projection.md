# 11. The session summary is a projection, not a second read

Date: 2026-10-01
Status: accepted

Numbered 0011, not 0007. Numbers are grouped by the worktree that produces the
ADRs, in the order those worktrees land. The partner-speech, first-sentence-
budget and cold-start-migration ADRs are all one branch and hold 0007 through
0009; issue #7's new-words ADR took 0010; this pair follows at 0011 and 0012.
What forced the grouping is that no merge had happened yet, so five branches
were each numbering themselves from 0007 while `main` still held nothing past
0006. See issue #15.

## Context

Issue #11 asks for an end to a Session worth looking at: a summary the learner
can review, reporting their response time per Turn and how often they bailed out
of one, with the full transcript still scrollable behind it.

A Debrief already exists and already reports a mean response time — but per
Sprint, from one scene of five minutes, and it lands in the transcript while the
session is still running. It cannot carry the end-of-session job. Three things
are missing from it, and all three are about the whole sitting rather than one
scene:

- **The sequence, not the average.** The product's claim is that hesitation
  shrinks with practice. A mean of twenty answers is one number and no story;
  the shape of the twenty is the thing that shows practice happening. The
  debrief's own `trend()` says as much in a single sentence, having thrown away
  the bars it was computed from.
- **Walk-aways.** The Fumble Deck already knows which turns the learner abandoned
  — that is what `reason: "abandoned"` means — but nothing reported the count.
  It is the failure this product measures most precisely, because unlike a slow
  answer it is unambiguous.
- **Survival of a reload.** The whole architecture rests on the server owning the
  session (ADR 0003). A summary that is only ever assembled in the browser, or
  fetched from an endpoint at the moment a session ends, is a summary that can
  disagree with the transcript — and a learner reloading a finished session would
  get a different answer to the live one.

## Decision

**The summary is a pure function of state the client already has, and that state
comes from the server. There is no summary endpoint.**

### The module

`src/lib/summary.ts` is `buildSummary(session, turns, sprints, fumbles)` returning
a `SessionSummary`, plus `summaryLines()` for the wording. It touches no
environment, so the browser imports it directly — the same arrangement
`measure.ts` already uses, and for the same reason: how a number is collected and
how it is worded are one decision and live in one file.

This is the only genuinely new testable unit in the project. `npm test` runs it
under `node --test` via tsx, with no test framework added.

### Getting the fumbles there

`SessionSummary` counts walk-aways and works out which fumbled words came back
out, both of which need the session's fumble rows — the deck cannot answer them,
because the deck is what the learner still owes rather than what happened.

So `fumbles: Fumble[]` joins `SessionState` (read by `getSessionState`) and
`Committed` (read on every `done` frame). It is session-scoped, not deck-scoped:
a word fumbled last week is not this sitting's doing.

Carrying it on `Committed` is what removes the race. The moment a session ends is
a commit — the last sprint's closing exchange carries `status: "ended"` — so the
frame that ends the session is the frame that carries the final fumble list. The
summary is available on the same paint the wrap-up appears, with no second
request, and therefore no window where the learner is looking at a summary that
is still loading.

### Why not an endpoint

A `/summary` route would be a fourth thing that can fall out of step with the
transcript, and the one place it would show is the screen the learner trusts most.
It would also need its own staleness question: fetched at session end, it is
correct until the next commit; fetched on load, it is correct for a session that
has since grown. Deriving it means the summary is wrong exactly when the
transcript is wrong, which is the only condition under which that is acceptable.

### The honesty rules

The summary is the screen most likely to be believed, so the tests are mostly
about what it refuses to say. `TREND_MIN_SAMPLES` (4) and `TREND_MIN_DELTA_MS`
(2000) are copied from the debrief's `trend()` so the sprint card and the
end-of-session account cannot disagree about whether a learner sped up. Three
consequences, each with a test:

- Fewer than four measured turns, or a first-half/second-half gap under two
  seconds, and all three trend fields are `null`. A flat session is a normal
  session.
- An unmeasured turn stays in `pace` — it happened — but out of every mean. The
  count of them is reported, so the average is never quietly flattering.
- A walk-away is phrased as a ratio only when `learnerTurns >= 3 × (1/rate)`.
  One abandoned turn in four is a measurement, and "one in four" is a claim about
  a habit four turns have not shown.

## Consequences

- **The summary cannot drift from the transcript.** There is one derivation from
  committed state, used by the live end of a session and by a reload of a
  finished one, and they are the same code.
- **The wrap-up shares the column with the transcript.** Both scroll; the panel
  is capped rather than allowed to grow, because the transcript is half of what
  makes a session worth reviewing. This needed `grid-template-rows: minmax(0, 1fr)`
  on the shell — the default `auto` row sizes to the tallest child, so the
  summary ended up below the bottom of the window instead of dividing the height
  with the feed.
- **The chart is a chart, so it needs an accessible equivalent.** Each bar
  carries its own sentence — turn number, scene, time, and whether it was a
  walk-away — in a visually-hidden span, because the numbers behind the bars are
  otherwise only visible.
- **Unmeasured turns are visible, not skipped.** A bar drawn hollow keeps a turn
  the browser could not time from being mistaken for a fast answer.
- **The start screen answers the same question in advance.** `src/server/stats.ts`
  reads the deck size and the last *finished* session's word count, so the learner
  sees what they are walking into. Only ended sessions qualify: an open one is
  being worked on now, and quoting its halfway numbers as a completed sitting
  would be a lie.
- **Nothing here is a model opinion.** Every field is counted from committed
  turns and fumbles, which is the constraint the debrief already worked under and
  the reason a regression in this screen shows up as a missing number rather than
  a wrong opinion.
