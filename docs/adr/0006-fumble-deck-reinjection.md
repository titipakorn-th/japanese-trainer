# 6. The Fumble Deck is closed by re-injection and self-clears on production

Date: 2026-09-30
Status: accepted

## Context

Issue #4 captured the Fumble Deck: a row per moment the learner failed to
produce a word, aggregated by natural form so the coach rail can show a list
ordered by how often each word has been fumbled. That half is silent and safe —
capture runs in the same model call as the partner's reply, rows land in the same
transaction as the turn, and a regression is visible from a glance at the deck
count. It is the load-bearing signal that practice is targeting the right words.

Issue #5 is the other half: the deck is useless without a loop that closes. A
word the learner hunted for, hedged around, or abandoned has to come back, in
another conversation, in a situation where they have to reach for it again. The
product hunts the specific reason the learner went quiet and builds a situation
that forces the word out under the same pressure that defeated them. Without
this, the deck is a list nobody acts on.

Two questions needed answers before any code:

- **How does a deck word come back?** A model asked to mention a word will
  mention it; a model asked to engineer a situation that requires the word will
  put it where the learner cannot avoid it. The distinction matters: a word
  that appears incidentally in a sentence the learner could dodge is not
  retrieval practice. A word they had no choice but to reach for is.
- **How does a word leave the deck?** It is not the same in practice as
  capture. Capture writes a row when the learner failed; clearance stamps a
  row when the learner produced the same word naturally in a later conversation.
  The deck shrinks visibly as the learner improves — shrink is the clearest
  single signal of progress, so the lifecycle is a first-class behaviour rather
  than a cleanup job.

## Decision

**The deck is fed back into every turn's instructions, and self-clears when the
learner produces one of the entries unprompted.**

### Re-injection

The active deck is the set of distinct natural forms on the `fumble` table where
`cleared_at IS NULL`, ordered by `count DESC, last_seen_at DESC` — the same
aggregation the rail already shows. The list is read fresh each turn and passed
into `buildSystemPrompt` as `deckWords: string[]`, the natural forms.

The system prompt adds a `デッキ:` block when the list is non-empty. The block
tells the partner to construct a situation that requires at least one of the
words — not to mention it, not to teach it, but to make it the only way for the
learner to advance the conversation. When the partner's reply contains one of
the words, the model attaches a marker of `kind: "deck"` so the learner can see
the engineered word in the transcript.

The marker kind is a fourth alongside `new`, `fumble`, and `grammar`. The same
marker-parser anchors `surface` against the partner's reply server-side, and a
reloaded session renders byte-identically to the live stream. The deck
marker is rendered with a teal dashed underline and a `戻` label so it reads
apart from the blue dotted `新` marker: the learner has met the word before, and
the session is putting it back into play.

### Detection of self-clearing

The same fenced JSON block that carries `markers`, `fumbles`, and `drill` carries
a fourth field, `produced`:

```json
{
  "markers": [...],
  "fumbles": [...],
  "produced": [{"natural": "会計"}]
}
```

`produced` is the model's judgement that the learner just produced one of the
deck words naturally in this turn. Each entry is the natural form itself, and
the field is empty on the common case. An opening turn has no learner text and
so cannot have a `produced` field; a closing turn can.

This piggybacks on the same model call as the partner's reply. A second call
would double the latency the whole product is built around (ADR 0001), and the
detection is the same judgement the partner just performed — a continuation of
classifying the learner's turn, not a separate step.

### Self-clearing

`produced` is read into `ParsedReply.produced: string[]` (after deduplication)
and acted on right after the turn commits:

```ts
if (parsed.produced.length > 0) clearDeckNaturals(parsed.produced);
```

`clearDeckNaturals(naturals)` issues one `UPDATE fumble SET cleared_at = ?
WHERE natural = ? AND cleared_at IS NULL` per natural. The transaction is
`db.transaction` so either the turn and the clearance commit together, or
neither does. A learner who produces two deck words in one turn is one
`commitExchange` write and two clearance updates; a learner who produces none
is no clearance at all.

The deck the next turn reads is the cleared version, so a word the learner
just produced is no longer being engineered into the partner's reply on the
turn that follows. The deck shrink is immediate — not at the end of the session,
not at the debrief, but at the same commit that wrote the learner's turn.

### Visibility

The `Committed` event the server emits includes the full deck array, not just
its size. The rail shows the natural forms as teal chips with `×N` for entries
that have been fumbled more than once, so the learner can see both which words
are still on the deck and how often each has slipped before. The list shrinks
on screen as the entries are cleared.

The deck words are also distinguishable from genuinely new vocabulary in the
transcript by the marker kind, the colour, the underline, and the label. The
legend in the rail's Markers card shows a `戻` sample alongside `新`, `文`,
and `△` so the learner knows what a deck marker looks like before they see
one in their first session.

### Idempotency and history

`clearDeckNaturals` only updates rows where `cleared_at IS NULL`, so a learner
who produces the same word twice across two turns has it stamped with the
timestamp of the first success — not overwritten with a later one. The
`cleared_at` column lets the deck history be inspected retroactively: every
moment is preserved, even ones whose word has since left the deck.

The sprint debrief still lists every fumble captured during the sprint,
including ones that were later cleared. A moment is a moment, and clearing a
word does not rewrite the sprint that produced it.

## Consequences

- **The deck shrinks visibly during a session.** A learner who produces `会計`
  unprompted sees the rail's teal chip disappear on the next frame. This is the
  honest progress signal: shrink means progress, and the absence of shrink is
  visible at a glance.
- **The partner reads the deck every turn.** A word that was cleared on turn N
  is no longer engineered into turn N+1's reply, because the deck is read fresh.
  This avoids asking the partner to put back a word the learner already has.
- **`produced` is a fourth detection prompt in the same call.** The
  silent-regression risks called out in ADR 0005 apply to deck-clearance in the
  same shape. A `produced` field the model stops reporting looks like a session
  that flows normally while the deck silently stops shrinking. Whenever the
  detection prompt in `prompt.ts` is touched, drive the app and watch a deck
  entry clear before shipping — a deck that stopped shrinking is a regression
  even when nothing looks broken.
- **The marker system absorbs the new marker kind cleanly.** Reusing the
  `Marker` shape with `kind: "deck"` keeps `AnnotatedText`, the popover, and
  the inline layout in one place. No new rendering path; the colour and
  underline do the work.
- **A fumble's `drilled` flag and its `cleared_at` timestamp live
  independently.** Drilling is the partner breaking character; clearing is the
  learner producing the word unprompted. A moment can be drilled without being
  cleared (the learner failed the retry) or cleared without being drilled
  (the learner just said it). The two states are first-class and can coexist.

## Rejected

- **Marking deck words with `kind: "new"`.** Conflates two distinct categories:
  a genuinely new word the learner has not met, and a deck word the learner has
  met before and is being re-engineered. The transcript loses the distinction
  the spec calls out. Also breaks the `SessionView`'s "New Words met" count,
  which is meant to be a count of first encounters.
- **Stamping a single timestamp on all uncleared fumbles for a session.**
  Loses per-moment detail the debrief still relies on. The current schema
  keeps one row per detection and stamps them individually.
- **Clearing the deck on the deck-shrink signal alone — a substring match of
  the learner's text against the deck naturals.** The model judges whether the
  learner produced the word naturally — a Japanese phrase the learner knows —
  rather than whether the string appears in their text. `会計` appearing in a
  turn where the learner wrote it from a glossary is not the same as producing
  it naturally; the model's `produced` field is the only class of action that
  carries the nuance.
- **A separate model call for `produced`.** The latency budget is the whole
  product (ADR 0001). A second call would push the first sentence later and
  double the cost on a field the model is well-placed to fill as part of the
  same reply.
- **Reading the deck once at session start.** The deck shrinks during the
  session. A prompt built from a stale deck keeps engineering words the
  learner has already produced, which is the same regression as a model that
  stops reporting fumbles — silent failure on the most important progress
  signal the product shows.
- **Hiding cleared fumbles from the debrief.** A moment is a moment. The
  sprint debrief is the record of what happened in the sprint, and clearing a
  word later does not rewrite the scene that produced it.