"use client";

import { splitSentences } from "@/lib/sentences";
import { segmentForFurigana } from "@/lib/readings";

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
 */
export function StreamedText({
  text,
  furiganaOn = false,
  revealed,
  onReveal,
}: {
  text: string;
  furiganaOn?: boolean;
  revealed?: ReadonlySet<string>;
  onReveal?: (surface: string) => void;
}) {
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

function FuriganaSpan({
  text,
  furiganaOn,
  revealed,
  onReveal,
  className,
}: {
  text: string;
  furiganaOn: boolean;
  revealed: ReadonlySet<string> | undefined;
  onReveal: ((surface: string) => void) | undefined;
  className?: string;
}) {
  if (!text) return className ? <span className={className} /> : null;
  const segs = segmentForFurigana(text);
  const node = (
    <>
      {segs.map((seg, i) => {
        if (seg.kind === "plain") return <span key={i}>{seg.text}</span>;
        if (furiganaOn) {
          return (
            <ruby key={i}>
              {seg.text}
              <rt>{seg.reading}</rt>
            </ruby>
          );
        }
        if (seg.hard) {
          if (revealed?.has(seg.text)) {
            return (
              <ruby key={i} className="revealed">
                {seg.text}
                <rt>{seg.reading}</rt>
              </ruby>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className="kanji-tap"
              data-surface={seg.text}
              aria-label={`Reveal reading of ${seg.text}: ${seg.reading}`}
              onClick={() => onReveal?.(seg.text)}
            >
              {seg.text}
            </button>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
  return className ? <span className={className}>{node}</span> : node;
}