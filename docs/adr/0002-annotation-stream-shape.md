# 2. Annotations travel after the prose, and corrections travel as a line

Date: 2026-09-29
Status: accepted
Amended: 2026-10-01, for issue #13 — see "A reply that is only a correction" under Consequences.

## Context

A turn needs three things out of one model call: the partner's line, a quiet correction of how
the learner would have said it, and inline markers for the New Word, Fumble and Grammar Point
in that line.

The latency budget says the first sentence must be on screen within 700–900ms. The markers
have to be rendered inline, which means they have to be known before the text is displayed —
and they are not, because deciding what counts as a New Word takes the same call that produces
the line.

## Decision

**The prose goes first, the annotations trail behind.**

The reply is a partner's line, optionally a `修正:` correction line, then one fenced JSON block
of markers. The server streams only the prose and withholds everything from the correction line
and the fence onward — except when the correction line is all there is, which makes it the prose
itself. The client renders the prose as it arrives, and when the turn commits it re-renders the
same text with the markers applied.

Two things make this work:

- **The client re-derives the sentence split from the whole accumulated text on every chunk**,
  rather than appending to the DOM. A terminator at the end of what has arrived counts as
  complete, and a closer that turns up two chunks later is absorbed into the same sentence on
  the next pass. The first sentence renders promptly and still ends up correct.
- **Marker character ranges are resolved server-side**, against the final text, and stored
  with the turn. A reloaded session renders byte-identically to the live stream, and a marker
  whose `surface` is not actually in the text is dropped rather than misplaced.

**The quiet correction is a line, not a JSON field.** Asked for `{"natural": "..."}` the model
copies `{"natural": ""}` out of the prompt's example and returns it empty every time. Asked for
a line it should write after its reply, it complies. The markers stay in JSON, where they are
reliable.

## Consequences

- A turn is corrected retroactively: the learner reads an uncorrected line, then a quiet
  correction appears under **their** turn, not under the partner's. The partner never breaks
  character, which is the point.
- **A malformed or missing metadata block is not a failure.** The turn happened; it just
  arrives without markers. Failing there would throw away a good exchange over a cosmetic
  defect.
- **A correction that is not a correction is dropped.** `naturalPhrasingFor` discards one that
  matches what the learner typed, one the partner's own reply already contains, and any at all
  on the opening line, where the learner has not spoken yet. A wrong correction is worse than
  none: it teaches the wrong thing and costs a glance at the exchange.
- A reply that is empty, or is not Japanese, is retried once and then surfaced as an error. The
  client is sent a `reset` frame first so a half-drawn first attempt is not left on screen
  beside the retry.
- **A reply that is only a correction is the partner's line.** The prompt already forbids this
  shape — it asks for the line first, says the correction is not the reply, and says not to go on
  to output 2 without a Japanese reply — so this is a model that ignored its instructions, not one
  that was asked for the wrong thing. Nothing in the prompt needed changing; the parser had to
  stop treating a disobedient reply as an absent one. It is not an error: what the model wrote is
  a Japanese sentence in the persona's voice, which is the whole content of a turn, and the
  correction is asked for as a sentence usable as-is. Treating it as an empty reply threw away an
  exchange the partner did have and showed the learner an error for a turn where something was
  said. So the correction becomes the line, and it is deliberately **not** also returned as the
  quiet correction — the learner is already reading it, and the same sentence twice in one turn is
  the duplication that follows. This is the one case where the prose and the correction are the
  same text. A second `修正:` line in the same reply is stripped of its marker and kept as prose:
  the marker itself is still the one string that never reaches the learner.
- **The visible prose only ever grows.** Deltas are sent as `prose.slice(sent)` and never
  retracted, so anything the client has been sent has to stay true. A half-written `修正:`
  marker, a fence still opening, and a trailing blank line are all withheld or trimmed rather
  than shown, because each can still resolve into something that re-decides where the prose
  ends. A blank line before a correction is the case that needs it: shown as prose, it is
  already on screen when the correction arrives and redefines the text, and the next delta
  slices into the middle of a word.

## Rejected

- **Inline markers in the prose** (`[new:お通し|…]`). The first sentence would either wait for
  the annotations or render raw markup in the middle of the learner's conversation.
- **A second call for the annotations.** Doubles cost and delays everything final, for a
  product whose premise is that the first sentence arrives quickly.
- **Resolving marker ranges on the client.** The client would then be the source of truth for
  how a turn renders, and a reload would not match what was streamed.
