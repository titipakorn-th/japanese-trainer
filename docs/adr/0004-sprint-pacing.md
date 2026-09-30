# 4. Sprints end on a clock, and a turn count caps them

Date: 2026-09-30
Status: accepted

## Context

The spec asks for a session of 4–6 sprints totalling "roughly 30 minutes", and it
asks for the session to end "on its own" without the learner timing it. Those two
requirements are in tension, and the tension is the learner.

A sprint's length is set by how long the learner takes to read the partner's line
and write their own. At 18 seconds a turn, eight turns is two and a half minutes
and a five-sprint session is twelve. At 90 seconds a turn, the same eight turns is
a five-sprint session of an hour, and something has to stop it. Neither learner
gets thirty minutes from a fixed number of turns.

The spec also has no background timer available to it: the server only runs while
a request is in flight, so nothing can end a session while nobody is looking.

## Decision

**A sprint ends on a clock. A turn count caps it. Neither is a background job —
both are checked when a turn is requested.**

`SPRINT_MS` (6 min) is the terminator, and it is the only one that can be. The
learner sets the pace by reading and typing, so the same eight turns is two and a
half minutes for a fast learner and seven for a slow one, and a five-sprint
session built on a turn count lands anywhere between twelve and forty minutes. A
clock is six minutes for everyone, which is what makes "4–6 sprints, roughly half
an hour" a promise the app can actually keep. `SESSION_MS` (30 min) outranks the
plan: a session past its window ends on the spot rather than opening a scene it
has no time for.

`SPRINT_TURNS` (20) is a cap, and it is there for one reason — to stop a brisk
exchange from running to twenty-five turns inside a single scene. It is not what
decides how long anyone's practice is, which is why it is twenty and not eight.

Two details that only showed up once the thing ran:

- **The clocks start when practice starts, not when the record is created.** A
  session row is written when the learner presses Start; the first turn is
  committed later. Measured from the record, a session opened and left for twenty
  minutes was born out of time and ended on its opening line with a debrief
  covering a conversation that never happened. Both clocks now start at the first
  committed turn, and a session with no turns cannot be out of time.
- **A scene's clock starts when the partner first speaks in it**, which is the same
  thing for every scene but the first.

## Consequences

- **A sprint's turn count varies with the learner, from about four to twenty.**
  That is the point: the thing being held constant is the six minutes, and the
  number of exchanges inside it is a fact about the learner rather than a setting.
  The debrief reports what actually happened, and the "average answer time" and the
  first-half/second-half trend on it are more meaningful over twenty turns than over
  eight.
- **The cap can still end a session early.** Getting through twenty turns inside six
  minutes means under eighteen seconds a turn including the model's own reply, and
  the debrief will say the sprint "ran its full length" — meaning the cap, which is
  what ended it. The end-of-session panel reports the real totals either way.
- **An idle session does not end until the learner next speaks.** A session that
  sits at minute 25 unanswered is still resumable at minute 40, and its next sprint
  will be closed by the session clock with a debrief that says so. Ending it in the
  background would mean a timer, a sweeper, and a session that changes under a
  learner who is mid-sentence.
- **The debrief's duration is a wall-clock span, not time spent practising.** A
  sprint resumed the next day reports the span honestly ("3 turns in about
  40分くらい") next to the measured answer time, and leaves the reader to see that
  the two disagree. There is no honest way to measure practice time from a store
  that only knows when turns were written.
- **Six minutes a sprint is a guess until it is measured against real sessions.**
  Nothing has watched a learner sit in one, and the first real session that does
  should be read for how the debrief's duration compares to the six minutes the
  clock charged. If learners are consistently getting cut mid-thought, the fix is a
  longer `SPRINT_MS` and a shorter session, not a bigger turn cap.

## Rejected

- **Ending the sprint on a fixed turn count**, which is what this decision was
  originally written as. It holds a number steady and lets the wall clock drift,
  which is backwards: the spec promises half an hour of practice, and only the clock
  can keep that promise for a learner whose speed is not known in advance.
- **A background timer that ends idle sessions.** Needs a sweeper in a process that
  is otherwise request-scoped, and it changes a session's state while the learner is
  looking at it.
- **Re-planning the remaining sprints as time runs out.** Adapting the plan to the
  clock produces sessions of wildly different lengths and a debrief that has to
  explain why there were only two sprints.
- **Letting the learner set the length.** The spec is explicit that they should not
  have to time anything, and a control is an invitation to skip the debrief.
