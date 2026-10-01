## Problem Statement

An N4–N3 Japanese learner reads and understands Japanese, but cannot hold a real conversation. The gap is not knowledge — it is performance under time pressure. Four failure modes show up in the same real conversation:

1. **Can't follow native speed.** The same words that land when spoken slowly wash out at real conversational speed.
2. **Can't retrieve the right word mid-sentence.** The situation is understood, the exact word for the thing in front of them isn't available, so they circle a synonym or describe it in English.
3. **Grammar collapses under pressure.** Word order, particles, and register degrade once the turn timer is running.
4. **Freezing.** They can form a sentence given time; on their turn, they go quiet.

Existing tools each fix a different slice and leave this one alone:

- **SRS flashcard apps** (Anki and kin) train recognition, not production. A learner can recognise `名義` on a card and still not produce it when a waiter asks who the tab is for.
- **General-purpose chatbots** produce unlimited conversation but no diagnosis. They react to what was said, not to the specific reason the learner went quiet, and they adapt nothing between sessions.
- **Scripted textbook dialogues** never surprise. The learner never has to survive an unknown word, which is exactly the skill that fails.

The learner wants one thing: to keep a real conversation going without dropping out of it.

**Scope note, stated up front:** this version is text-only, so it addresses failure modes 2, 3, and 4 — retrieval, grammar under pressure, and freezing. It does **not** address mode 1, native-speed listening, because text can be skimmed at any speed. That failure mode is real and stays unsolved until the text-to-speech work described under *Deferred: text-to-speech* is picked up; word-level timestamps from that API are what a listening-speed trainer would be built on. Everything below should be read as solving three of the four problems.

## Solution

A text-first web app that runs 30-minute structured sessions of realistic Japanese conversation against an LLM partner, and treats the learner's failures as the primary data.

Each session is 4–6 **sprints** of 5–7 minutes. A sprint is one scene with one person and one goal — order dinner, ask a colleague to redo the deck, find out why the train stopped. Real life is a sequence of short conversations with different people, not one continuous one, and sprinting keeps the feedback loop inside seven minutes instead of thirty.

Every turn is a three-part loop:

1. The partner replies, and any words the learner hasn't met are marked inline. Each is inferable from context, and each can be tapped for a gloss without pausing the conversation.
2. The learner answers. In the same model call, the server decides the next line, harvests what the learner failed to retrieve, and judges whether the moment warrants interrupting to drill.
3. What was harvested goes into the **Fumble Deck**.

The Fumble Deck is the actual product. A word the learner hunted for, hedged around, or abandoned gets stored with the situation and the natural phrasing — and then the partner is *instructed to engineer a situation that requires that word again*. Not "review your vocabulary." The words you cannot produce get designed back into your next conversation until they are automatic.

Each session also weaves in a target of 10 new words and one grammar point, chosen to shorten the conversation rather than decorate it. Corrections stay quiet by default so the session feels like a real exchange; drilling is reserved for the specific phrases that failed.

## User Stories

### Starting a session

1. As a learner, I want to start a session from my phone in under ten seconds, so that I actually do it daily instead of putting it off.
2. As a learner, I want the app to tell me which scenarios are available before I commit, so that I can pick one that matches what I need today.
3. As a learner, I want sessions to be structured rather than open-ended, so that I know what I'm getting and it doesn't sprawl.
4. As a learner, I want a session to end at roughly 30 minutes on its own, so that it fits my day without me having to time it.
5. As a learner, I want to abandon a session mid-way and keep the progress, so that a bad ten minutes doesn't cost me the whole thirty.
6. As a learner, I want to see my Fumble Deck size and last-session word count before starting, so that I know what I'm walking into.

### Holding a conversation

7. As a learner, I want the partner to speak at a natural pace, so that I'm practising the real thing and not a textbook.
8. As a learner, I want the partner to stay in character for the whole sprint, so that it feels like a real exchange and not a lesson.
9. As a learner, I want to be able to say "I don't know the word" in Japanese and have the conversation survive it, so that practising recovery is part of practising conversation.
10. As a learner, I want the partner to follow up rather than just answer, so that I'm held to a real multi-turn exchange instead of a series of independent questions.
11. As a learner, I want the partner to stay on a goal for the sprint, so that the conversation goes somewhere instead of wandering.
12. As a learner, I want the partner to introduce a complication when I'm doing well, so that the sprint doesn't flatten out once I'm comfortable.
13. As a learner, I want the partner to slow down and rephrase when I'm clearly lost, so that one bad turn doesn't end my practice for the day.
14. As a learner, I want the partner to never correct me mid-flow by default, so that the conversation stays intact.
15. As a learner, I want the natural phrasing to appear quietly after I've spoken, so that I learn the correct form without the exchange stopping.
16. As a learner, I want the partner to interrupt and ask me to repeat when a specific phrase failed, so that a specific error gets drilled rather than noted.

### Learning vocabulary

17. As a learner, I want to meet roughly 10 new words per session, so that thirty minutes produces real progress.
18. As a learner, I want new words to appear in a sentence I can already mostly follow, so that I can infer the meaning instead of being handed a translation.
19. As a learner, I want to tap a new word and see its reading, meaning, and an example, so that I get it without losing the conversation.
20. As a learner, I want a new word to be *used again* later in the same session, so that I have to retrieve it rather than just recognise it.
21. As a learner, I want roughly half the new words to come from words I've previously failed to produce, so that my effort is spent where I'm actually weak.
22. As a learner, I want to be told plainly when a session was a consolidation day, so that a low word count isn't mistaken for a wasted session.
23. As a learner, I want the session's word budget visible while I'm in it, so that I know how the session is going without leaving the conversation.
24. As a learner, I want to avoid meeting more than three new words at once, so that a sprint never becomes a wall of unknowns.

### Learning grammar

25. As a learner, I want one grammar point per session, so that it's learnable rather than a list.
26. As a learner, I want the grammar point chosen because it makes my sentences shorter, so that learning it visibly improves my speech.
27. As a learner, I want to see the grammar point used in several different sentences during the session, so that I learn the pattern and not one memorised phrase.
28. As a learner, I want to see today's grammar point on screen while I use it, so that I can connect the pattern to the moment I needed it.
29. As a learner, I want the grammar point explained in plain terms with a concrete example, so that I understand why it exists.

### Handling Japanese I can't read

30. As a learner, I want furigana off by default, so that I'm testing my own reading rather than the app's data.
31. As a learner, I want one tap to turn furigana on for the whole session, so that I can read a passage properly when I choose to.
32. As a learner, I want a kanji I can't read to be tappable rather than an unreadable gap, so that a single hard kanji never breaks a sentence for me.
33. As a learner, I want the kanji I tapped to stay revealed for the rest of the session, so that I don't have to keep re-tapping the same one.
34. As a learner, I want reading aid to not apply to words already written in kana, so that the page isn't cluttered with readings I don't need.

### The Fumble Deck

35. As a learner, I want every word I failed to produce captured automatically, so that I don't have to remember to log it.
36. As a learner, I want each captured fumble to record the situation and the natural phrasing, so that I can see why I reached for it.
37. As a learner, I want the app to require my problem words in later conversations, so that I get to practise them under the same pressure that defeated me.
38. As a learner, I want to see my Fumble Deck with the words I've failed most often first, so that my effort goes to the worst offenders.
39. As a learner, I want a word to leave the Fumble Deck once I've produced it unprompted, so that the deck shrinks as I improve.
40. As a learner, I want the sprint debrief to list this sprint's fumbles, so that I know what to work on immediately.

### Sessions, sprints, and review

41. As a learner, I want each sprint to end with a short debrief, so that I get feedback while the moment is still fresh.
42. As a learner, I want to retry the one moment I fumbled, immediately, so that a specific failure gets a second attempt.
43. As a learner, I want to see a summary of a whole session after it ends, so that I can review it.
44. As a learner, I want to scroll back through a finished session, so that I can re-read what I actually said.
45. As a learner, I want to see my response time per turn, so that I can see my hesitation getting shorter over time.
46. As a learner, I want to see how often I bailed out of a turn, so that I can see whether freezing is improving.

### Robustness

47. As a learner, I want a failed model call to leave my conversation intact so I can retry, so that a network blip doesn't lose my session.
48. As a learner, I want a clear error when something breaks, so that I know whether to retry or whether the app is down.
49. As a learner, I want my session data to survive a page reload, so that a refresh doesn't wipe my progress.
50. As a learner, I want my data stored locally, so that my Japanese mistakes are not sitting in a cloud account.

## Implementation Decisions

### Platform and stack

- A **web app installable as a PWA**, usable on the learner's Mac and phone from one URL. Chosen over native iOS because iteration speed matters more than audio fidelity in a text-first product, and over a desktop app for no benefit.
- A **server-side component** holds the model key, the session state, and the caches. The model key must never reach the client.
- A **local relational store** for sessions, turns, vocabulary, and the Fumble Deck. Single user, no accounts, no auth, no multi-tenancy. The learner is the only user.
- Client state is not the source of truth for a session; the server is. A reload resumes from the server.

### The model

- **MiniMax `M2-her`** as the conversation partner, over the OpenAI-compatible chat completions endpoint. It is documented as built for role-playing and multi-turn dialogue, which is exactly this use case, and it keeps the whole stack on one provider and one key.
- One model call per turn does three jobs at once: produce the partner's next line, detect what the learner fumbled, and report any fumbles that should be drilled immediately. Splitting these into separate calls would double latency and cost for no benefit.
- The reply is **streamed** and **sentence-split as it arrives**, so the first sentence is rendered as soon as it is complete rather than waiting for the whole reply. Streaming is what makes a ~1.5s first sentence tolerable at all: without it the learner waits for the whole reply, not just its first sentence. The 500ms figure this design originally assumed is not reachable with any model on the current account and is withdrawn as a target.
- The system prompt is assembled per turn from the sprint brief, the learner's level, the words already met this session, the Fumble Deck targets, the session's grammar point, and the corrections policy. It is a substantial, carefully-structured prompt and is treated as a first-class artifact, not an afterthought.

### Session structure

- A **session** is 4–6 **sprints** totalling ~30 minutes.
- A **sprint** is 5–7 minutes: one persona, one situation, one goal. It ends with a ~30-second debrief and an immediate retry of the single worst fumble.
- Real life is a sequence of short conversations with different people, so sprinting matches the actual skill. The sprint boundary is accepted as a small immersion tax in exchange for closing the feedback loop within seven minutes.

### The 10-word rule

- **10 new words is a target, not a quota.** The session planner injects new words until the conversation shows strain — measured as a rising rate of short or abandoned turns — then stops injecting and spends the remaining time on the Fumble Deck.
- When this happens the app says so plainly and labels the session a consolidation day. Progress is reported as words actually met, never as a `10/10` that misrepresents the session.
- The mix is roughly **5 genuinely new words** chosen for the scenario and the learner's level, and **5 drawn from the Fumble Deck** — words already failed once. The deck half is the higher-value half: a word never seen is a fact, while a word that was failed and then met again under pressure is a trained skill.
- **Maximum 2–3 new words per sprint.** A sprint carrying three unknowns is still a real conversation; more than that is where conversations start stalling. Four sprints of 2–3 lands in the 8–12 range.

### The grammar point

- **One grammar point per session**, selected as the highest-leverage pattern for the learner's level and the sprint's scenario — chosen specifically because it lets the learner express several things in one short sentence instead of two clumsy ones.
- The partner is instructed to use it **three or four times in different sentence frames**, so it lands as a pattern rather than a single memorised phrase.
- The point is shown on the coach rail throughout the session with a plain-language rationale and a concrete example, so the learner connects the pattern to the moment they needed it.

### Corrections

- **Quiet by default.** The partner stays in character and never corrects mid-flow. The natural phrasing appears beside the learner's turn after the fact.
- **Drill on trigger.** When the model judges that a specific phrase failed in a way worth interrupting for, the partner asks the learner to say it again in character. This is the only case where the conversation stops.
- A fumble is recorded when the learner abandons a turn, compresses a required phrase past naturalness, hedges around a word they clearly wanted, or produces a form a native speaker would not use.

### Furigana

- **Off by default.** A reading aid that is always on measures the app's data, not the learner's reading. Hard to reverse once it becomes habit.
- With furigana off, a word the learner is unlikely to read renders as a **tappable target rather than an invisible gap**, so a single hard kanji never breaks a sentence.
- A tap reveals the reading for the rest of the session, not just for that one occurrence.
- Readings come from a **kanji reading dictionary keyed on surface form**, longest-match-first. A word already written entirely in kana gets no reading rendered.
- A `hard` flag marks words the learner probably cannot read yet, which is what distinguishes "render as plain text" from "render as a tap target".
- One toggle switches furigana on for the whole session.

### User interface

The chosen layout combines two of the four prototyped variants.

- **From "The Reader":** generous Japanese type (19px, 2.0 line height), ruby readings, tap-to-reveal kanji, the furigana toggle in the header, and a colour legend for the three inline markers. Larger type and looser leading because Japanese is dense vertically and comfortable reading is a prerequisite for everything else.
- **From "The Desk":** a persistent **coach rail** showing the session's 10 word slots filling as words are met, today's grammar point with its example and rationale, sprint progress, and the live Fumble Deck.
- **Inline markers** appear in every message: blue for a new word, amber wavy underline for a fumble, purple for the grammar point in use. Each is tappable for a gloss — reading, meaning, and an example sentence — which opens without pausing the conversation.

### Colour semantics

Four colours carry meaning consistently across the whole interface and are defined once as tokens: accent red for the learner's own turns and primary actions, blue for new vocabulary, amber for a fumble, purple for the session's grammar point. Colour is never the only signal — each marker also differs by underline style or by an explicit label.

### Latency

- Budget: first sentence of the partner's reply on screen within ~1.5s of submitting a turn, timed in the browser from submit to the first sentence being complete to read. This is what the partner model actually does (1.3–1.8s in the app); the original 700–900ms figure described `M2-her`, which does not exist on this account, and no model available here reaches it. See `docs/adr/0008-first-sentence-budget.md`.
- Achieved by streaming the model reply, sentence-splitting on the client, and rendering the first sentence as soon as it terminates.
- The learner's own thinking time is *not* latency to optimise — it is the point of the exercise.

### Error handling

- **Model call fails or times out:** the conversation does not advance, the learner's typed turn is preserved for retry, and the failure is surfaced. Session state is server-side, so a failed call cannot lose the thread.
- **Any component fails:** the session survives and remains resumable. Partial failure degrades the experience; it never destroys it.
- **Turn comes back empty or in the wrong language:** discarded and regenerated once, then surfaced as an error rather than shown to the learner.

### Deferred: text-to-speech

TTS was specified, prototyped, and then cut from this version in favour of a text-only product. The research is preserved here because it is the obvious next candidate and the decision was a scope choice, not a rejection of the approach.

- The **MiniMax `POST /v1/t2a_v2` endpoint** supports `stream: true` over SSE, so audio can begin playing before synthesis completes, and returns **word-level timestamps** alongside the audio when `subtitle_enable: true` and `subtitle_type: "word_streaming"` are set. Those timestamps enable karaoke highlighting, replay of a single word, and detection of precisely which word the learner failed to catch — a direct attack on the native-speed listening failure.
- Japanese system voices are available, `language_boost: "Japanese"` is supported, `<#x#>` pause markers and `emotion` control allow a partner that hesitates and sounds flat or surprised rather than reading everything in monotone, and `usage_characters` is returned on every call so cost is measurable.
- **Text-to-speech cache design, held ready:** key on a hash of model, voice id, speed, volume, pitch, emotion, `language_boost`, `pronunciation_dict`, audio settings, and the exact text — every one of those changes the audio. Value is the decoded MP3 binary *plus* the subtitle payload, because caching only the audio would destroy the word-level highlight on every replay. Stored server-side on disk so it survives restarts and follows the learner across devices, with LRU eviction and a size cap, since roughly 200 unique lines per session runs to about 3MB and reaches a gigabyte within a year uncapped. Expect a low hit rate on genuinely conversational lines; the cache earns its keep on fixed scaffolding — greetings, scenario framing, drill cues — which is also the layer that must never stutter, so the fixed utterance set is pre-warmed at session start.

### Deferred: speech-to-text

- A custom STT pipeline was considered and rejected for this version in favour of OS dictation into the text field, which removes an entire audio pipeline and costs nothing. The known constraints to revisit if it returns: dictation follows the keyboard rather than the app, so an English input mode silently yields English and needs a script check on the transcript; and the same device playing the partner out loud then opening the mic risks transcribing the partner's own audio tail as the learner's words.

## Testing Decisions

**This project tests manually, by driving the app in a browser each session.** There is no automated test suite. Fumble detection is therefore protected by observation rather than by assertions.

- **What makes a good test here:** driving the real app in a real browser and reading the real numbers off the coach rail. A test that exercises the internals would pin the prompt's shape, and the prompt will change often for reasons that have nothing to do with correctness.
- **What gets manual verification:** the full session loop, the coach rail filling correctly, furigana on/off and tap-to-reveal persistence, the TTS-free degradation path, model-call failure and retry, and session resume after reload.
- **The one place this choice has a cost**, stated plainly: **fumble detection can regress silently.** If the model stops reporting fumbles, sessions still look fine — conversations flow, words get taught, nothing visibly breaks — while the Fumble Deck silently stops filling and the learner loses weeks of targeted practice without noticing. This is accepted for now. The mitigation is to glance at the Fumble Deck count after any change to the detection prompt and treat a drop to zero as a bug even when nothing looks broken.
- **Prior art:** none. This is the first module in the repository.

## Out of Scope

- **Text-to-speech and speech-to-text.** Text-only for this version. Both are specified above and deliberately deferred.
- **Avatars, video, or any talking-character presentation.** Excluded on cost and on the uncanny-valley risk.
- **A kanji SRS ladder or standalone kanji drilling.** Furigana is a reading aid inside conversation. Kanji mastery is tracked as a `hard` flag on words, not as its own study system.
- **Adaptive per-kanji furigana.** Furigana is a global session toggle. Deciding per word which readings to show needs a per-kanji mastery model that does not exist yet.
- **Accounts, sign-in, multi-user, and cloud sync.** Single learner, local data.
- **Native iOS or Android apps.** PWA only.
- **JLPT exam preparation and any graded scoring.** The target is conversational fluency, not a test score.
- **Offline mode.**
- **A durable external word list.** Vocabulary enters through the Fumble Deck and session injection, not through user import.

## Further Notes

- **A UI prototype was built during design** and covered four structurally different session layouts — chat bubbles, chat-plus-coach-rail, a turn-card feed, and a furigana-first reading surface. The spec takes the reading surface's typography and furigana treatment with the coach-rail layout. The prototype is throwaway and is not production code.
- **The prototype settled a real question about furigana placement**: words inside a new-word or fumble marker already carry a colour, so the reading aid composes *around* them rather than inside them. A word the learner is meeting for the first time gets its reading from the new-word popover, not from a ruby annotation.
- **Known scope risk worth naming:** the sprint planner's strain detection — the signal that decides when to stop injecting new words — is the least specified part of this design and the most likely to need tuning against real sessions. It starts as a simple heuristic on turn length and abandonment rate.
- **The hardest thing to get right is not any single feature.** It is that the learner keeps talking. Every decision above is in service of that: the sprint boundary shortens the wait for feedback, corrections stay quiet so the exchange survives, furigana stays off so the text is readable unaided, and the partner is never allowed to stall on an error.
