/**
 * Incremental sentence splitting for streamed Japanese.
 *
 * The partner's reply arrives token by token. The first sentence has to land on
 * screen the moment it terminates, not when the reply finishes, so the client
 * re-derives the split from the whole accumulated text on every chunk rather
 * than appending to the DOM. That keeps closers landing on the right sentence:
 * when `」` turns up two chunks after `。`, the earlier sentence simply grows.
 *
 * A terminator at the very end of what has arrived counts as complete. That
 * costs nothing — a closers-only tail is absorbed into the same sentence on the
 * next chunk — and it is the difference between the first sentence rendering
 * promptly and not rendering at all.
 */

const TERMINATORS = new Set(["。", "！", "？", "!", "?", "\n"]);

/** Punctuation that belongs to the sentence it terminates, not the next one. */
const CLOSERS = new Set(["」", "』", "）", ")", "】", "〕", "》", "〉", "”", "’", "…"]);

export interface SplitText {
  /** Terminator-terminated sentences, in order. */
  sentences: string[];
  /** The tail after the last terminator. Empty once the reply is settled. */
  partial: string;
}

export function splitSentences(text: string): SplitText {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined || !TERMINATORS.has(ch)) continue;

    // Absorb any closers that trail the terminator, plus the terminator run
    // itself, so `？。」` stays one sentence.
    let end = i + 1;
    while (end < text.length) {
      const next = text[end];
      if (next === undefined) break;
      if (CLOSERS.has(next) || TERMINATORS.has(next)) {
        end++;
        continue;
      }
      break;
    }

    sentences.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }

  return { sentences, partial: text.slice(start) };
}

/**
 * The index in `text` at which the first complete sentence ends, or -1 if no
 * sentence has terminated yet. Used to time "first sentence visible".
 */
export function firstSentenceEnd(text: string): number {
  const { sentences } = splitSentences(text);
  const first = sentences[0];
  return first ? first.length : -1;
}
