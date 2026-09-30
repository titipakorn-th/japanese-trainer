"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Marker, MarkerKind } from "@/lib/types";
import { segmentForFurigana } from "@/lib/readings";

/** The label each marker carries, so colour is never the only signal. */
const LABELS: Record<MarkerKind, { text: string; name: string }> = {
  new: { text: "新", name: "New Word" },
  fumble: { text: "△", name: "Fumble" },
  grammar: { text: "文", name: "Grammar Point" },
  deck: { text: "戻", name: "From the Fumble Deck" },
};

interface OpenGloss {
  marker: Marker;
  anchor: HTMLElement;
}

interface AnnotatedTextProps {
  text: string;
  markers: Marker[];
  /** The session's furigana toggle. Default false. */
  furiganaOn?: boolean;
  /** Surface forms the learner has already tapped to reveal. */
  revealed?: ReadonlySet<string>;
  /** Add a surface to the revealed set; ignored when furiganaOn is true. */
  onReveal?: (surface: string) => void;
}

/**
 * Render a turn's text with its inline markers and the furigana reading aid.
 *
 * Markers and furigana compose rather than fight: a word inside a marker has
 * already been given a colour, so its reading rides the marker's popover and
 * not a ruby annotation. The reading aid fills the gaps between markers and
 * the tails before and after the first and last one.
 *
 * With `furiganaOn` true, every known kanji segment renders as a `<ruby>`. With
 * it false, a segment marked `hard` in the dictionary renders as a tappable
 * target that the learner can tap once to flip it to a revealed ruby for the
 * rest of the session; the rest render as plain text.
 */
export function AnnotatedText({
  text,
  markers,
  furiganaOn = false,
  revealed,
  onReveal,
}: AnnotatedTextProps) {
  const [open, setOpen] = useState<OpenGloss | null>(null);
  const show = useCallback((marker: Marker, anchor: HTMLElement) => {
    setOpen({ marker, anchor });
  }, []);

  if (markers.length === 0) {
    return <Furigana text={text} furiganaOn={furiganaOn} revealed={revealed} onReveal={onReveal} />;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const marker of markers) {
    if (marker.start > cursor) {
      parts.push(
        <Furigana
          key={`t${marker.id}`}
          text={text.slice(cursor, marker.start)}
          furiganaOn={furiganaOn}
          revealed={revealed}
          onReveal={onReveal}
        />,
      );
    }
    parts.push(
      <MarkerToken
        key={marker.id}
        marker={marker}
        onOpen={show}
        active={open?.marker.id === marker.id}
      />,
    );
    cursor = marker.end;
  }
  if (cursor < text.length) {
    parts.push(
      <Furigana key="tail" text={text.slice(cursor)} furiganaOn={furiganaOn} revealed={revealed} onReveal={onReveal} />,
    );
  }

  return (
    <>
      {parts}
      {open ? (
        <GlossPopover marker={open.marker} anchor={open.anchor} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

/**
 * Render a piece of text with the furigana reading aid applied.
 *
 * The function is intentionally not memoised: the cost of re-running is one
 * `segmentForFurigana` pass over a short string, which is what `<ruby>` itself
 * costs the browser to layout. Wrapping it in memo would buy a number of
 * dependencies to track for no measurable win on the text lengths we render.
 */
function Furigana({
  text,
  furiganaOn,
  revealed,
  onReveal,
}: {
  text: string;
  furiganaOn: boolean;
  revealed: ReadonlySet<string> | undefined;
  onReveal: ((surface: string) => void) | undefined;
}) {
  if (text.length === 0) return null;

  const segments = segmentForFurigana(text);
  if (segments.length === 1 && segments[0]!.kind === "plain") {
    return <span>{text}</span>;
  }

  return (
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
        // Furigana off. A segment flagged `hard` and not yet revealed is the
        // exact thing the spec calls out: a tappable target, not a gap. Once
        // the learner has tapped it, the reading stays visible for the rest
        // of the session.
        if (seg.hard) {
          if (revealed?.has(seg.text)) {
            return (
              <ruby key={i} className="revealed">
                {seg.text}
                <rp>(</rp>
                <rt>{seg.reading}</rt>
                <rp>)</rp>
              </ruby>
            );
          }
          return (
            <KanjiTap key={i} surface={seg.text} reading={seg.reading} onReveal={onReveal} />
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

/**
 * The "tap to reveal" target for one hard word.
 *
 * It is a button rather than a span so it is focusable and keyboard-tappable,
 * but it does not interrupt the conversation — the reveal is a state mutation,
 * not a navigation. The aria-label includes the reading, so a screen reader
 * learns the word on first focus, before the learner has decided to reveal it.
 */
function KanjiTap({
  surface,
  reading,
  onReveal,
}: {
  surface: string;
  reading: string;
  onReveal: ((surface: string) => void) | undefined;
}) {
  const handle = useCallback(() => {
    onReveal?.(surface);
  }, [onReveal, surface]);
  return (
    <button
      type="button"
      className="kanji-tap"
      data-surface={surface}
      aria-label={`Reveal reading of ${surface}: ${reading}`}
      onClick={handle}
    >
      {surface}
    </button>
  );
}

function MarkerToken({
  marker,
  onOpen,
  active,
}: {
  marker: Marker;
  onOpen: (marker: Marker, anchor: HTMLElement) => void;
  active: boolean;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const label = LABELS[marker.kind];

  return (
    <button
      ref={ref}
      type="button"
      className={`marker ${marker.kind}`}
      aria-label={`${label.name}: ${marker.surface}. ${marker.meaning}`}
      aria-expanded={active}
      onClick={() => {
        if (ref.current) onOpen(marker, ref.current);
      }}
    >
      {marker.surface}
      <span className="label" aria-hidden="true">
        {label.text}
      </span>
    </button>
  );
}

function GlossPopover({
  marker,
  anchor,
  onClose,
}: {
  marker: Marker;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const label = LABELS[marker.kind];

  // Clamp inside the viewport, and flip above the token when there is no room
  // below. A popover that runs off the bottom of a phone screen is worse than no
  // popover at all.
  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    const a = anchor.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    const margin = 8;

    const left = Math.min(
      Math.max(margin, a.left + a.width / 2 - box.width / 2),
      Math.max(margin, window.innerWidth - box.width - margin),
    );

    const below = window.innerHeight - (a.bottom + 10) - box.height - margin;
    const top = below < 0 ? Math.max(margin, a.top - box.height - 10) : a.bottom + 10;
    pop.dataset.placement = below < 0 ? "above" : "below";

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.setProperty("--caret-left", `${a.left + a.width / 2 - left}px`);
  }, [anchor, marker]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [anchor, onClose]);

  return (
    <div ref={ref} className="gloss" data-kind={marker.kind} role="dialog" aria-label={label.name}>
      <span className="caret" aria-hidden="true" />
      <div className="kind">{label.name}</div>
      <b className="surface jp">{marker.surface}</b>
      {marker.reading ? <div className="reading jp">{marker.reading}</div> : null}
      {marker.meaning ? <p className="meaning">{marker.meaning}</p> : null}
      {marker.example ? <p className="example jp">{marker.example}</p> : null}
      <button type="button" className="gloss-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}