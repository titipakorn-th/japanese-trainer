# 3. A turn commits whole or not at all

Date: 2026-09-29
Status: accepted

## Context

The spec requires that a failed or timed-out model call "does not advance the conversation"
and that "session state is server-side, so a failed call cannot lose the thread." The learner
is looking at their own typed turn on screen while the call is in flight, and the failure can
arrive at any point: before the first token, halfway through the stream, or after the model
has finished but before the turn is written.

Server-side state is the source of truth for a session. A reload resumes from it.

## Decision

**The learner's turn and the partner's reply are written in one transaction, after the model
has finished cleanly, and never before.**

Nothing is persisted while the stream is in flight. `commitExchange` is only reached on a
reply that is non-empty and in Japanese. A turn that fails — refused connection, timeout,
unparseable reply, a retry that also failed — writes nothing at all, so the session's `seq`
does not move and the transcript is byte-identical to what it was before the submit.

The client's draft is never touched by the turn machinery. It lives in the composer's state and
is only cleared on `done`, so a failure leaves the typed text in the field with the transcript
unchanged behind it.

The in-flight learner turn is rendered from separate state, not from the committed list, so
when the call fails it disappears from the transcript by construction rather than by a
rollback. It is dimmed while it is in flight, because a turn that has not been accepted should
not look accepted.

## Consequences

- Retrying after a failure sends the same text and produces the same conversation position.
- A reload during a turn loses the in-flight exchange, which was never real yet. The learner's
  typed text is in the browser's own field, not in the session, so a reload before submitting
  keeps it; a reload after submitting starts that turn again.
- The timeout is a single `TURN_TIMEOUT_MS` budget for the whole call, and it is enforced with
  an `AbortSignal` that the client also feeds into, so navigating away cancels the call instead
  of leaving it running.
- One turn per session at a time, held in an in-memory set. Single learner, so there is nothing
  to reconcile and nothing to persist.

## Rejected

- **Writing the learner's turn when it is submitted.** It makes the transcript show a turn the
  server did not accept, and it needs a second path to retract it on failure.
- **Writing turns as they stream.** Every partially-received turn would have to be
  retractable, and a network drop mid-stream would leave the session permanently one half-turn
  ahead of what the learner was shown.
- **Rolling back on failure.** Correct in principle, but it makes "did this fail?" a question
  about ordering rather than a question about whether the write ever happened.
