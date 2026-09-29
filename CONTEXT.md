# japanese-trainer

A text-first Japanese conversation trainer for a single N4–N3 learner. The
learner can read and understand Japanese but stalls when they have to produce
it in real time. The app exists to close that gap.

## Domain vocabulary

Use these terms exactly. They are the load-bearing concepts of the product.

- **Session** — one 30-minute practice sitting, made of several Sprints.
- **Sprint** — a 5–7 minute scene with one persona, one situation, one goal.
  A session is 4–6 sprints. Real life is a sequence of short conversations, not
  one continuous one.
- **Turn** — one exchange within a sprint: the partner speaks, the learner
  replies. A sprint is many turns.
- **Stance** — how the partner is behaving on one turn, decided from the
  learner's own words before the model is called: follow up (`plain`), make it
  harder because the learner is coping (`harder`), slow down and rephrase because
  they are lost (`slow`), or hand over the word they said they did not have
  (`give-word`). The partner's good conduct is four stances, not one prompt.
- **Debrief** — the short account of what happened in a sprint, written from the
  committed turns alone and shown in the transcript as the sprint ends. It
  reports measurements, never an opinion of the learner.
- **Fumble** — a moment the learner failed to produce the right word or form:
  an abandoned turn, a phrase compressed past naturalness, hedging around a
  word they clearly wanted, or a form a native speaker wouldn't use.
- **Fumble Deck** — the persistent list of words the learner has fumbled, with
  the situation and the natural phrasing. The deck is re-injected into later
  conversations so the learner is forced to retrieve those words again. The
  deck shrinking is the clearest signal of progress.
- **New Word** — a piece of vocabulary introduced for the first time in a
  session, met inside a sentence the learner can already mostly follow.
- **Grammar Point** — the one grammar pattern taught per session, chosen to
  make the learner's sentences shorter. Used several times in the sprint so it
  lands as a pattern, not a memorised phrase.
- **Drill** — the one case where the partner breaks character to make the
  learner repeat a specific phrase. Reserved for specific failures.
- **Consolidation day** — a session that stopped injecting New Words because
  the conversation showed strain and spent the remainder on the Fumble Deck.
  Reported honestly, not as a wasted session.

## Relationships

- A **Session** contains several **Sprints**.
- A **Sprint** is a sequence of **Turns**.
- A **Sprint** ends with a **Debrief**.
- A **Turn** happens under exactly one **Stance**.
- A **Turn** can produce zero or more **Fumbles**.
- A **Fumble** adds a word to the **Fumble Deck**.
- The **Fumble Deck** constrains which words future **Sessions** must require.
- A **Session** targets ~10 **New Words** and exactly one **Grammar Point**.

## Non-goals

This is a conversation trainer, not a study tool. It is not flashcards, not a
JLPT exam prep course, and not a grammar textbook. If a change makes it more
like those, it is probably wrong.
