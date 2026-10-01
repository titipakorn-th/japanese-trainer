"use client";

import { splitSentences } from "@/lib/sentences";
import { FuriganaSpan, type FuriganaInput } from "./Furigana";

/**
 * A partner turn while it is still arriving.
 *
 * The split is re-derived from the whole accumulated text on every chunk rather
 * than appended to the DOM, so the first sentence lands the moment its
 * terminator arrives. The tail after the last terminator is dimmed: it is
 * visibly incomplete, which is honest about what has and has not been said.
 *
 * Streaming text has no markers yet — those arrive with the metadata fence at
 * commit — so the rendering is just the furigana reading aid, no inline tags.
 * It goes through the same `FuriganaSpan` the committed transcript uses, so a
 * word that is a tap target mid-stream is the same tap target once it lands.
 */
export function StreamedText({ text, furiganaOn, revealed, onReveal }: FuriganaInput & { text: string }) {
  const { sentences, partial } = splitSentences(text);
  const complete = sentences.join("");
  return (
    <span>
      <FuriganaSpan text={complete} furiganaOn={furiganaOn} revealed={revealed} onReveal={onReveal} />
      {partial ? (
        <FuriganaSpan
          text={partial}
          furiganaOn={furiganaOn}
          revealed={revealed}
          onReveal={onReveal}
          className="partial"
        />
      ) : null}
    </span>
  );
}
