# 4. Sprints end on a turn budget, and the clock is a backstop

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

**A sprint ends on a budget of learner turns. A clock backstops both the sprint and
the session. Neither is a background job — both are checked when a turn is
requested.**

`SPRINT_TURNS` (8) is the primary terminator, because it is the only one that
actually bounds the work: a slow learner gets a shorter session, and a brisk one
gets a longer sprint with more in it. `SPRINT_MS` (6 min) and `SESSION_MS` (30
min) catch the cases a budget cannot see — one very slow turn, a learner who
closes the tab — and the session clock outranks the plan, so a session past its
window ends on the spot rather than opening a scene it has no time for.

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

- **A brisk learner finishes early.** At 18 seconds a turn a five-sprint session is
  about twelve minutes, not thirty. The alternative is padding the session with
  turns the learner did not need, and a session that reports 30 minutes because the
  app kept it open for 30 minutes is the exact dishonesty this product is trying to
  avoid. The debrief and the end-of-session panel report the real numbers, and the
  track shows how many sprints are left.
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
- **The default turn budget is a guess until it is measured against real sessions.**
  Eight turns is the figure that makes 8 × ~40s land near the spec's 5–7 minute
  sprint, not a figure anyone has watched a learner hit. Re-tune `SPRINT_TURNS`
  against real sessions, and read the debrief's average answer time to do it.

## Rejected

- **Making the sprint a pure wall clock** (keep going until 6 minutes are up, cap at
  N turns). This makes a brisk learner's sprint a twenty-turn ramble and a slow
  learner's sprint three turns, which is the opposite of the same trade — and it
  makes the sprint's length depend on a number the app cannot control.
- **A background timer that ends idle sessions.** Needs a sweeper in a process that
  is otherwise request-scoped, and it changes a session's state while the learner is
  looking at it.
- **Re-planning the remaining sprints as time runs out.** Adapting the plan to the
  clock produces sessions of wildly different lengths and a debrief that has to
  explain why there were only two sprints.
- **Letting the learner set the length.** The spec is explicit that they should not
  have to time anything, and a control is an invitation to skip the debrief.
