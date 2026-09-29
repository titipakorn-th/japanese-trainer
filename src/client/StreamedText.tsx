"use client";

import { splitSentences } from "@/lib/sentences";

/**
 * A partner turn while it is still arriving.
 *
 * The split is re-derived from the whole accumulated text on every chunk rather
 * than appended to the DOM, so the first sentence lands the moment its
 * terminator arrives. The tail after the last terminator is dimmed: it is
 * visibly incomplete, which is honest about what has and has not been said.
 */
export function StreamedText({ text }: { text: string }) {
  const { sentences, partial } = splitSentences(text);

  return (
    <span>
      {sentences.join("")}
      {partial ? <span className="partial">{partial}</span> : null}
    </span>
  );
}
