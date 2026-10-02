# 13. A strained session stops injecting and becomes a consolidation day

Date: 2026-10-02
Status: accepted for the signals; thresholds pending observation

Numbered 0013 because `main` holds 0001 through 0012. This branch was cut before
0010 landed, so its working copy shows no 0007 through 0012; the number follows
`main`, not the branch.

## Context

A session targets ten new words, and injecting unknown words into a live
conversation is the thing that makes the learner freeze. Inject too many and the
session stalls on word three — and the stall gets written off as the learner's
own ability rather than as a consequence of the injection rate. A hard quota of
ten is simple to reason about, produces a clean daily number, and is also the
option that quietly damages the thing the product is for.

The alternative is to inject until the conversation shows strain, then stop and
spend the remainder of the session on the Fumble Deck, and report the day as what
it was rather than as a 10/10 that misrepresents it.

The issue is explicit that this is the least specified part of the design and
should not be built blind, and it names four candidate signals: a rising rate of
short turns, a rising rate of abandoned turns, rising response time, and the model
reporting confusion. Choosing between them needs real sessions, because the
difference between them is not a matter of taste — it is a matter of what a
learner under strain actually does.

## What the sessions on this machine actually show

The store holds 21 sessions, all `izakaya`. Twelve have no learner turns at all.
Across the whole store there are 15 learner turns, and three of them are plainly
developer smoke-tests — `昨日{Shibuya}は雨がふって没有得到罗马`,
`Yeah, umm, five, uh, spicy please`, and one with a Korean word in it. Of the
remaining twelve, only one session has a multi-turn exchange at all.

Four of the sessions are also *idle* in a way worth naming, because it is the
reason the count is so low and it is invisible without looking at the
timestamps. `3fec3f` sat for sixteen and a half hours between its opening and its
single reply; `cd8bd5` for one hundred and seven minutes; `df67d7` for
fifty-four. A session opened and left is a burnt record — it holds a real
compose time and it is not a sample of a conversation, and the session clock
correctly ends it the moment the learner returns. `probe:strain-data` now labels
these and excludes them from the pool, because letting them in would be the one
way the probe could lie convincingly. A session has to be started and finished
in one sitting to be worth anything here.

That session, `4d9c35`, is the only evidence available, and it is worth more than
its size suggests. Its compose times were 24.3s, 57.6s and 67.9s — a monotonic
rise across three consecutive turns — while its turn lengths stayed flat at six
characters. So the learner got slower to produce the same amount.

**A rising rate of short turns would have scored that session as perfectly
healthy.** Turn length did not move at all. The signal that moved was the learner
spending more time per character, which is effort rather than disengagement. This
is the observation the rest of the decision rests on.

The measurement itself is sound. `useTurn` starts the clock when a `done` event
lands and stops it at submit, so `response_ms` is the time from the partner's line
becoming readable to the learner's turn being sent, with none of the model's
latency in it. Two things make it sparser than it looks, and both are structural
rather than broken: the first learner turn of a session is never measured,
because there is no prior partner line in the page to measure from, and a reload
clears the clock so the first turn after one is unmeasured too. Guessing either
would put a fabricated number into the signal.

## Decision

**Compose-time rise gates injection, fumble rate corroborates it, and turn length
is not a signal at all.**

1. **Compose time is the primary signal.** The evidence above is the reason, and
   it is a reason about what strain *is* rather than about which threshold is
   convenient. A learner under strain is still producing sentences; they are
   reaching for them more slowly. Short turns measure something else — terseness,
   which at N4 is frequently the correct register for an order at a counter.

2. **Fumble rate is the second signal, not an alternative.** A rising count of
   `compressed` and `abandoned` fumbles is the same phenomenon observed from the
   model's side: the learner reaching for a word and not landing it. It is
   corroboration rather than a separate gate, because it is derived from the same
   turn and therefore cannot be late in the way an independent signal could.

3. **The measure is the first-half to second-half mean compose time, reused from
   `debrief.ts`.** That function already splits a sprint's response times and
   reports a pace change when the halves differ by more than two seconds. The
   strain detector is the same arithmetic used as a gate rather than as a report
   line. Two implementations of "did the learner slow down" would be one too many,
   and a number the learner has already read in a debrief is a number they can be
   asked to act on.

4. **Strain is evaluated at the sprint boundary, not mid-scene.** The gate decides
   whether the *next* scene injects. A scene that has already gone quiet does not
   get abandoned mid-sentence to save a number, and the learner is not told to
   stop producing. This is also the cheapest place to evaluate it, since the
   ledger is already rebuilt there.

5. **Strained means the new-word allowance goes to zero and the deck allowance
   goes up.** The prompt is told the remaining budget the same way the per-sprint
   cap is told it — prospectively, not enforced by dropping markers afterwards.
   This follows the reasoning in ADR 0010: a cap enforced after the fact is a cap
   the transcript silently lies about. The scene brief changes to say that the
   remaining scenes are for the words the learner has already failed.

   This is also why the gate itself is one boolean. ADR 0010 already made the
   prompt render a zero allowance as `new は0個`, so forcing the allowance to zero
   is the whole of the *stop*. The prompt does still change, and the reason is
   worth recording because the first version of this ADR claimed it did not.

   Stopping is only half of what the issue asks. "Spends the rest of the Session
   on the Fumble Deck" is a different instruction from the ordinary one, not the
   same one with a smaller number in it: the normal deck line offers a deck
   marker as optional (`deck を0〜1`), and a session told `new は0個` alongside
   `deck を0〜1` has been told to introduce nothing at all. Left as it was, a
   strained session would not have shifted its budget anywhere — it would have
   stopped spending words and started going quiet. So `markerHint` gained a
   strain branch that requires a deck marker, and `src/server/prompt.ts` is
   touched after all.

   The branch has three cases rather than one "deck or revisit" line, because the
   model follows a worked example far better than a disjunction, and because the
   third case is the one that would otherwise fail quietly: a strained learner
   with an empty deck has no deck word to aim at, so the fallback is the words
   already met — the `revisit` machinery ADR 0010 built — and if there are none of
   those either, the partner is told to keep the scene moving without markers
   rather than being handed an instruction that produces an empty turn.

   `strained` is passed to the prompt rather than inferred from a zero allowance.
   The allowance also reaches zero for the ordinary reason, a scene that has used
   its three words, and reading that as strain would push the Fumble Deck at every
   capped scene in every healthy session.

6. **A session that stopped early is a consolidation day, and says so.** The
   session record carries the flag, the coach rail reports words actually met
   rather than a fraction of ten, and the debrief's closing line is:

   > Consolidation day. 6 new words met, 4 deck words drilled under pressure. A
   > word you failed and then met again is the part that sticks.

   The number is honest and the framing is chosen deliberately. This is the
   learner's call on voice, and the reasoning is that a session which met six new
   words and drilled four under pressure did real work — the line names the
   shortfall without apologising for it, and it does not read as a session that
   went wrong. A rail that filled 6/10 cells with no explanation would.

7. **The mechanism is built; the two numbers that arm it are not.** Issue #10
   requires the thresholds to come from observed sessions rather than estimation,
   and the store cannot support that yet. Not one session has ever produced the
   four measured compose times needed to split it into halves — the floor
   `debrief.ts` already uses, and the most this machine has ever produced in one
   session is three. `npm run probe:strain-data` reports per-session whether a
   session is usable and why not, so that a half hour of practice is not spent
   producing data that cannot be read. The thresholds are filled in from that
   output, and the ADR moves to fully accepted when they are.

   `COMPOSE_TIME_RISE` and `FUMBLE_RATE_RISE` in `src/server/strain.ts` are typed
   `null` rather than holding a plausible number, and `isStrained` returns
   `false` for every input while they are. Everything else is finished and
   tested: the gate is derived from committed turns, it forces the allowance to
   zero, the flag rides the session snapshot and every commit frame, and the
   summary leads with the consolidation line. An uncalibrated build behaves
   exactly as it did before this ADR — the conversation is unchanged and the
   line does not appear — which is the only acceptable state for a number this
   project would otherwise be guessing.

## Consequences

- **`prompt.ts` is touched, so the app-level check this project requires applies to
  it — and it could not be run.** The standing rule is that a change here is only
  verified by driving the app, typing a deliberately bad turn, and watching the
  deck count on the coach rail go up. That check is impossible on this build: the
  gate is inert, so no real session can reach the strain branch. What was done
  instead is the strongest check available without a strained session — the built
  prompt was hashed for six ordinary contexts and four strained ones on both `main`
  and this branch. All six ordinary digests were identical, all four strained
  digests differed, and the strained closing line was identical to the ordinary
  one. `src/server/prompt-strain.test.ts` keeps that as property tests rather than
  as golden hashes, so a legitimate prompt edit does not break them.
  The deck-count check is still owed, and the honest place to run it is the same
  sitting that supplies the thresholds: a session the gate actually closed is
  exactly the session to watch the deck in.
- **The probe is a guard against a silent failure, not a convenience.** The failure
  mode it prevents is specific: practising five sessions, deriving nothing, and
  discovering too late that none of them had enough measured turns. It reads the
  real store and writes nothing, so it is safe to run as often as liked. It is
  deliberately *not* in CI — CI has no real store, and a probe that passes against
  an empty database would report a false all-clear.
- **A session that reloads mid-scene loses one sample.** Over a five-scene session
  that is a meaningful loss against a floor of four, and a learner who reloads
  often will produce sessions that read as thin. That is the honest reading, and
  it is better than the alternative of timing from page load, which would count
  re-reading the transcript as hesitation.
- **The eight null `response_ms` values in the store are not evidence of a broken
  client.** They are the first turn of their sessions. This is now written
  down because it looks like a defect, and the next person to query the column
  will reach the same wrong conclusion.
- **Fumble rate has no threshold yet either,** for the same reason. It is wired in
  as corroboration with the compose-time gate deciding, so the session does not
  ship claiming a second signal it has not calibrated.
- **Strain detection is silent to the learner while it runs.** A scene that ends
  because the gate closed looks like any other scene. That is deliberate — a
  notice mid-conversation interrupts the thing being measured — but it means the
  transition is only visible after the fact, in the debrief.

## Rejected

- **Rising rate of short turns**, the issue's own first candidate. Rejected on the
  evidence in `4d9c35`, where length stayed flat through a tripling of compose
  time. It would have missed the one real session, and it punishes a learner for
  being appropriately brief.
- **The model reporting confusion.** It is the only signal that needs no
  interpretation, and it costs a model call on the turn path to obtain, for a
  decision that should be cheap and deterministic. A model that has noticed the
  learner is struggling is also a model that is about to change its behaviour,
  which is precisely when its report of the conversation is least trustworthy as a
  measurement of the conversation.
- **Rising response time as the sole gate.** Compose time moves, but slowly and
  late: in the one session it took three consecutive turns to become obvious. On
  its own it would let a tenth word into a session that was already struggling.
  Pairing it with fumble rate catches the case where the learner is fast but
  wrong.
- **Dropping markers after the fact to hit the budget.** Same objection as ADR
  0010, and the same answer: the transcript is the record, and a word that was put
  in front of the learner happened.
- **Setting the thresholds now from the one session.** It is the thing the issue
  forbids, and the reason is not squeamishness — three samples, one of them from
  a session that was itself largely a smoke test, would produce a number with no
  error bar and every appearance of a constant.
