"use client";

import { segmentForFurigana } from "@/lib/readings";

/**
 * The reading-aid input that travels together through every render path.
 *
 * The toggle, the per-session reveal set, and the reveal callback are always
 * passed as a group: a place that needs one needs all three, and threading them
 * individually through `AnnotatedText`, `Feed`, `StreamedText`, and the
 * renderer all at once is the kind of trip that loses a default. Bundling them
 * is what keeps the call sites honest.
 */
export interface FuriganaInput {
  furiganaOn: boolean;
  revealed: ReadonlySet<string>;
  onReveal: (surface: string) => void;
}

interface FuriganaSpanProps extends FuriganaInput {
  text: string;
  /**
   * Optional class for the wrapping `<span>`. The only caller that uses it is
   * the streaming partial, which dims the as-yet-incomplete tail to make it
   * visibly unfinished.
   */
  className?: string;
}

/**
 * The reading-aid renderer.
 *
 * Slices the text against the kanji dictionary longest-first and renders each
 * segment. Pure-kana runs go out as plain spans; kanji segments render as
 * `<ruby>` when furigana is on, as plain text when furigana is off and the word
 * is not flagged `hard`, and as a `KanjiTap` button when furigana is off and
 * the word is `hard` and not yet on the reveal set. Once the learner has tapped
 * one, the same segment flips to a revealed ruby and stays that way for the
 * rest of the session.
 *
 * One renderer, used by both committed turns (`AnnotatedText`) and the
 * in-flight stream (`StreamedText`). Keeping a single decision tree here is
 * what stops the two callers from drifting — the early prototype had a copy
 * in each, and the two had already lost the `<rp>` fallback before they were
 * consolidated.
 */
export function FuriganaSpan({ text, furiganaOn, revealed, onReveal, className }: FuriganaSpanProps) {
  if (!text) return className ? <span className={className} /> : null;

  const segments = segmentForFurigana(text);
  const fastPath = segments.length === 1 && segments[0]!.kind === "plain";
  const content = fastPath ? (
    <span>{text}</span>
  ) : (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "plain") return <span key={i}>{seg.text}</span>;
        if (furiganaOn) {
          return (
            <ruby key={i}>
              {seg.text}
              <rp>(</rp>
              <rt>{seg.reading}</rt>
              <rp>)</rp>
            </ruby>
          );
        }
        if (seg.hard) {
          if (revealed.has(seg.text)) {
            return (
              <ruby key={i} className="revealed">
                {seg.text}
                <rp>(</rp>
                <rt>{seg.reading}</rt>
                <rp>)</rp>
              </ruby>
            );
          }
          return <KanjiTap key={i} surface={seg.text} reading={seg.reading} onReveal={onReveal} />;
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );

  return className ? <span className={className}>{content}</span> : content;
}

/**
 * The "tap to reveal" target for one hard word.
 *
 * A `<button>` rather than a `<span>` so it is focusable and keyboard-tappable,
 * but reveals a state rather than navigating, so the tap does not interrupt
 * the conversation. The aria-label includes the reading so a screen reader
 * learns the word on first focus, before the learner has committed to
 * revealing it.
 */
function KanjiTap({
  surface,
  reading,
  onReveal,
}: {
  surface: string;
  reading: string;
  onReveal: (surface: string) => void;
}) {
  return (
    <button
      type="button"
      className="kanji-tap"
      data-surface={surface}
      aria-label={`Reveal reading of ${surface}: ${reading}`}
      onClick={() => onReveal(surface)}
    >
      {surface}
    </button>
  );
}