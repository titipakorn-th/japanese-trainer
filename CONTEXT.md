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
- **Session summary** — the account of the whole sitting, shown when a session
  ends and still there on every reload of it. Where a Debrief is one scene of a
  few minutes, the summary is the run of them: the learner's response time turn
  by turn rather than as one average, how often they walked away from a turn, and
  what became of the words they fumbled. It reports the shape of the session
  because the shape is the thing that changes with practice. Like a Debrief, it
  is counted from committed turns and never an opinion — and where the evidence
  is too thin to mean anything it says nothing rather than rounding a guess into
  a conclusion.
- **Fumble** — a moment the learner failed to produce the right word or form:
  an abandoned turn, a phrase compressed past naturalness, hedging around a
  word they clearly wanted, or a form a native speaker wouldn't use.
- **Fumble Deck** — the persistent list of words the learner has fumbled, with
  the situation and the natural phrasing. The deck is re-injected into later
  conversations so the learner is forced to retrieve those words again. The
  deck shrinking is the clearest signal of progress.
- **New Word** — a piece of vocabulary introduced for the first time in a
  session, met inside a sentence the learner can already mostly follow. A New Word
  is a fact until the partner needs it again later in the session in a different
  sentence; that second meeting is what turns it into something the learner can
  produce. See `docs/adr/0010-new-words.md`.
- **Grammar Point** — the one grammar pattern taught per session, chosen to
  make the learner's sentences shorter. Used several times in the sprint so it
  lands as a pattern, not a memorised phrase.
- **Drill** — the one case where the partner breaks character to make the
  learner repeat a specific phrase. Reserved for specific failures.
- **Consolidation day** — a session that stopped injecting New Words because
  the conversation showed strain and spent the remainder on the Fumble Deck.
  Reported honestly, not as a wasted session.
- **Voice** — how the partner sounds. Chosen per session, not per Turn, and
  applied to every partner line including Drills. It is not the Partner's
  persona: a Persona decides what they say, the Voice decides how it is heard.
- **Speech** — a partner line rendered as audio on the learner's request. A
  pure function of the line's text and the Voice, which is why it can never
  affect a Turn: it has no session and no history.
- **Timed word** — one word of speech with the millisecond range it occupies in
  the audio. What Karaoke highlighting is built from.
- **Karaoke highlighting** — highlighting each Timed word as it is spoken, so a
  learner can see the word they failed to catch. Specified and deliberately not
  built yet; the Timed words are stored for every line ever spoken.

## Relationships

- A **Session** contains several **Sprints**.
- A **Sprint** is a sequence of **Turns**.
- A **Sprint** ends with a **Debrief**.
- A **Session** ends with a **Session summary**.
- A **Turn** happens under exactly one **Stance**.
- A **Turn** can produce zero or more **Fumbles**.
- A **Fumble** adds a word to the **Fumble Deck**.
- The **Fumble Deck** constrains which words future **Sessions** must require.
- A **Session** targets ~10 **New Words** and exactly one **Grammar Point**.
- A **Session** has one **Voice**; a **Turn** can be heard as **Speech**.
- **Speech** for a **Turn** carries **Timed words**, which Karaoke highlighting
  would render. Nothing renders them yet.

## Non-goals

This is a conversation trainer, not a study tool. It is not flashcards, not a
JLPT exam prep course, and not a grammar textbook. If a change makes it more
like those, it is probably wrong.
