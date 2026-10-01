# 9. A session has a word budget, and a word met once is not yet trained

Date: 2026-09-30
Status: accepted

Numbered 0009, not 0007. The partner-speech and first-sentence-budget ADRs were
written and numbered first, in the same week, and 0007 and 0008 were already
taken when this one was ready to land. The decision and its date are unchanged;
only the slot in the sequence moved. See issue #15.

## Context

The issue asks for roughly ten New Words a session, woven into conversation. It
also says the more valuable half is the five drawn from the Fumble Deck, because
"a word never seen is a fact while a word that was failed and then met again under
pressure is a trained skill".

Three requirements do not fit together without a decision, and the third is the
one the rest of this rests on:

- Ten words a session, at a maximum of three per sprint, over four to six sprints.
- Each word must appear in a sentence the learner can already mostly follow, so
  the meaning is inferable.
- Each word must be used **again later in the same session, in a different
  sentence**, and the sprint debrief must ask for a short recall of the sprint's
  words.

The third is the problem. Recognition is reading: the learner sees the word in a
sentence and reads it off. Retrieval is speaking: the learner produces it. Only
the second is the skill the product is for. But nothing in the transcript could
tell those two apart, because a word the partner said once and a word the partner
said twice were the same kind of event — both were just a `new` marker. The debrief
could therefore ask for recall of words the session had never given a second chance
at, which is asking for something the session did not make possible, and reporting
it as though it had.

## Decision

**A `revisit` marker, a derived ledger, and a cap enforced in the prompt rather
than after the fact.**

**1. `new` and `revisit` are different events.** The first time the partner puts a
word in front of the learner this session it is a `new` marker. A later use of that
same word, in a different sentence, is a `revisit` marker. The second meeting is
recorded because it is the meeting that makes the word trainable, and because the
debrief has to be able to tell the learner which words it can honestly ask for.

A `revisit` marker carries no reading, meaning, or example. This is the load-bearing
detail: a revisit that re-supplied the gloss would hand the learner the answer at
the exact moment the app is trying to find out whether they have it, turning the
second meeting into a second recognition. The word stays visible and marked — the
learner has to be able to see that it is back — and what to do about it is the
debrief's problem.

**2. "A different sentence" is checked where it can fail.** Across turns it holds
by construction — a later turn is a later sentence — so there is nothing to check
and the check is skipped rather than faked. The one case where a reuse can land in
the same sentence is a partner that introduces and reuses a word inside a single
reply, and that case *is* compared against the first meeting, sentence by sentence.
A word twice in the same sentence is a repetition, not a second meeting.

This is also why `parse.ts` now resolves a repeated surface to its next occurrence
instead of dropping the second marker as an overlap; the old code's comment already
named this as the New Word work. That change applies to every marker kind, not only
`revisit`: a `grammar` or `new` marker that resolves to a surface already claimed
re-anchors to the next occurrence rather than vanishing. A word the partner used
twice in one sentence is visibly used twice, and dropping the second marking was
never a behaviour worth keeping.

**3. The budget is derived, not counted.** `buildWordLedger` walks the committed
partner turns and rebuilds the whole ledger on every read — for the rail, for the
prompt, for the debrief. No counter is carried alongside. A counter would be one
more thing that can disagree with the transcript after a reload, and the client is
a projection of the session rather than a second source of truth about it.

**4. The ten are five and five, and the five new ones are the scene briefs' own
words.** The new half is not chosen from a vocabulary list: it is the `WordSeed`
each `SprintBrief` already carries, one per scene, so `newTarget` is the number of
sprints in the plan. A four-sprint session targets four new and five deck; the
default five-sprint session targets five and five, which is the ten the issue
names. The deck half is capped at five as well, taking the worst offenders first,
because the deck is unbounded and a partner handed thirty words to weave in builds
a situation requiring none of them.

**5. The three-per-sprint cap is enforced prospectively.** The prompt is told how
much of the sprint's allowance is left, not told the ceiling and trusted. A cap
enforced afterwards by dropping markers would be a cap the transcript silently
lied about, and the sprint cap outranks the session target: a scene with three new
words in it has already stopped being a conversation, and a tenth word is not worth
a stalled scene.

**6. The recall runs meaning → word, not word → meaning.** The issue's own
justification is that "recognition is reading, retrieval is speaking, and only the
second one is the skill being trained", and the debrief is the only place in the
session where the learner can produce anything. So each row shows the *meaning* and
the word is the answer, behind a tap. A row that printed the word in bold and asked
for its reading would be the recognition the issue is trying to move past.

A Deck Word with no recorded meaning has nothing to work backwards from — the deck
marker deliberately carries no gloss — so those rows fall back to surface-first and
are marked, rather than being sold a harder question than they are being asked.

Nothing is scored or stored. The app has no answer key it could score a Japanese
production against except string-matching, and a wrong score is worse than none: the
learner would train against the app's judgement of their recall rather than their
own.

## Consequences

- **The rail draws the budget, and grows past it if the session does.** A bare count
  cannot be situated; a grid can be watched, and the unfilled cells say what the
  session has left to give. It draws `target` slots, or more if more words were met —
  a rail that stopped at ten while fourteen words sat in the transcript would be
  hiding an overrun, and the whole point of the derived ledger is that nothing is
  hidden. New and deck words keep their transcript colours, `seenAgain` gets a badge
  rather than a third hue, and the two halves are reported against their own targets
  so a session that has filled its new half and none of its deck half looks half
  done rather than invisibly behind.
- **Words met past the budget are still counted, still marked, and still recallable.**
  Only the grid is capped. `seenAgain` is counted over every word met, and the
  debrief resolves it from an uncapped list — resolving it from the grid would report
  "not needed again" for exactly the words an overrun produced, which is the one case
  where the claim matters.
- **The prompt is longer, and the revisit list is capped at six words.** Prompt
  length is paid twice — once in prefill, once in how much the model thinks about
  the job — and a partner handed twenty words to weave back in weaves in none of
  them. The most recent few are also the ones still within the learner's short-term
  reach.
- **A `revisit` for a word that was never marked as met is ignored.** The word is
  visibly in the transcript, but the app does not know when it was introduced, so
  it cannot claim a first meeting and a second one. That is a partner mistake, and
  the alternative — reclassifying it — is a guess the transcript cannot back up.
- **The recall is self-reported and resets on reload.** A learner who has looked
  does not get to un-look, and pretending otherwise would be a scoreboard.
- **A debrief is a snapshot at its boundary, and stays one.** `seenAgain` on a
  stored debrief card reflects the second meetings that had happened when the card
  was written. A word the partner needed again three scenes later does not
  retroactively change what the earlier card said, and this slice does not rewrite
  it. A card that edited itself after the learner had read it would be reporting
  something that had not happened yet when they read it, which is the same fault as
  a flattering debrief line.
- **Two acceptance criteria are instruction, not mechanism, and this ADR says so.**
  "A New Word appears in a sentence the learner can already mostly follow" is a line
  in the prompt: the sentence is model-generated and nothing inspects it, because
  inspecting it would cost a second model call on the latency-critical path for a
  judgement no rule can make. Likewise whether the model produces revisits at all is
  unmeasured. The ledger records
  what happened and the debrief reports it, but nothing forces the model to comply,
  and a sprint where every word is met exactly once is a sprint the app will
  honestly report as having offered no second chance. As with fumble detection,
  this is only visible by driving the app and reading the ledger.

## Rejected

- **A separate Word table with a lifecycle.** A vocabulary store with a "seen
  twice" flag would make the ledger queryable across sessions and would let the app
  know a word has been met before in an earlier sitting. The issue's loop is
  explicitly within one session, and the Fumble Deck is already the app's
  cross-session memory of what this learner struggles with. A second store would
  overlap it and go stale against it.
- **Marking the second meeting as a `deck` marker.** It would have avoided a new
  kind, but a deck word means a word fumbled in an earlier session. A new word used
  again in the same scene is not that, and the transcript claiming otherwise would
  put words in the learner's deck that were never fumbled.
- **Handing over the gloss on a revisit.** Cheaper, and it makes the transcript
  read better. It also answers the question the second meeting exists to ask.
- **Grading the recall against a stored answer key.** The words and their glosses
  are in the transcript already, so a key is buildable. But the app would then be
  marking a Japanese production with a string match, and a wrong score is worse
  than no score: the learner would train against the app's judgement of their recall
  rather than their own.
- **Enforcing the sprint cap by dropping the extra markers at commit.** Cheap and
  exact. It would also make the rail report three words in a scene that visibly
  contained four, and the transcript would stop being the thing the rest of the app
  believes.
