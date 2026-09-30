# 5. The Fumble Deck is captured from the same model call, stored per moment

Date: 2026-09-30
Status: accepted

## Context

Issue #4 says the model reports fumbles "in the same call that produces the next
partner line, with no extra latency." The whole project rests on capture: if the deck
silently stops filling, the product still looks fine while the learner loses weeks of
targeted practice without noticing. There are no automated tests for detection, so the
detection prompt is one of the most fragile pieces of the app, and the data model has
to be honest enough that a regression is visible from a glance at the coach rail.

Two questions needed answers before any code:

- **What is the deck?** A list of *words*, ordered by how often each one has been
  fumbled. Each word has a natural form, a count, and the most recent moment it
  happened.
- **What is a fumble?** A *moment* the learner failed to produce the right word or
  form. Each moment has a surface (what they said), a natural form (what they should
  have said), the full text of their turn, the partner's last line as the situation,
  and a reason.

## Decision

**One row per moment. The deck is a derived aggregation.**

A `fumble` row is written for every fumble the model reports. The deck — the list
the rail shows — is `GROUP BY natural ORDER BY count DESC, last_seen_at DESC`. The
sprint debrief lists the moments from that sprint directly, not an aggregation, so
the per-moment detail survives the grouping.

Two fields capture the gap between what the learner said and what they should have
said:

- `surface` — the substring of the learner's text the marker anchors to. Empty for an
  abandoned turn, where there is nothing to highlight.
- `natural` — the form they were reaching for. This is the deck key: the learner may
  say `billing`, `bill`, and `チェック` in three different turns, and all three end up
  on the same `会計` entry.

`learner_said` and `situation` are stored alongside, because "why they reached for
the word" is the whole reason the deck exists and has to be retrievable per moment.

### Marker integration

A fumble marker on a learner turn reuses the existing `Marker` shape with
`kind: "fumble"`:

- `surface` — the substring of learner text the marker underlines (amber, wavy, △)
- `reading` — empty (the surface is often English, and the gloss is the Japanese)
- `meaning` — the natural form
- `example` — a sentence using the natural form

Tapping the marker opens the existing gloss dialog, which already reads `surface`,
`reading`, and `meaning` — the only thing the dialog has to absorb for a fumble is
that the learner cares about `meaning` more than `surface`. The marker system
already anchors `surface` against the turn text server-side, so a reloaded session
renders byte-identically, and a marker whose `surface` is not in the text is dropped
rather than misplaced.

For abandoned turns where there is no surface to highlight, the fumble is recorded
in the deck but no marker is rendered. The deck count still grows, and the debrief
still lists it.

### Detection prompt

The same fenced JSON block that carries `markers` now carries `fumbles` alongside:

```json
{
  "markers": [...],
  "fumbles": [
    { "surface": "billing", "natural": "会計", "reason": "hedged" }
  ]
}
```

The prompt demonstrates the shape rather than specifying it — the project's smaller
model follows worked examples and ignores specifications. A fumble whose `surface`
is empty is the abandoned-turn case; the partner line never contains the wrong word
to anchor a marker to.

### Transactional capture

Fumble rows commit in the same `db.transaction` as the learner turn and the partner
reply. A failed model call writes nothing — including no fumble — so the deck does
not gain rows for turns that never happened.

## Consequences

- **The deck is monotonic across the session.** Words only enter it, never leave, on
  this slice. A word leaving the deck because the learner produced it unprompted is
  the work of issue #5, which builds on this.
- **The deck count grows visibly during the session.** A learner can glance at the
  rail and see whether the detection prompt is doing its job: a card that reads
  "Fumble Deck — 0" mid-session is the silent-regression signal the spec demands.
- **The deck key is a string.** Different surface forms for the same word end up on
  separate entries, because we do not yet know how to normalise 「会計」/「けいさい」
  reliably. The list grows more, not less, and the learner sees what they actually
  fumbled.
- **The sprint debrief lists moments, not words.** It can repeat the same natural
  form across two turns, which is the honest account — the learner fumbled it twice,
  not once.

## Rejected

- **One row per natural form, with a count column.** Loses the per-moment detail the
  debrief needs and overwrites the learner's original phrasing when the same word
  comes up twice.
- **A second model call for fumble detection.** The spec calls for it in the same
  call that produces the partner line, and the latency budget is the product — see
  ADR 0001. A second call would double cost and push the first sentence later.
- **Inline fumble markup in the prose.** Same trade as ADR 0002 for markers: the
  first sentence would wait for the metadata block, or render with raw markup in
  the middle of the learner's text.
- **Markers on partner turns for fumbles.** A fumble is what the *learner* said, not
  what the partner said. Marking the partner's line would put the amber underline
  next to a word that is not the problem.
