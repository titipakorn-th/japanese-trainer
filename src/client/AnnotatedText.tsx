"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Marker, MarkerKind } from "@/lib/types";

/** The label each marker carries, so colour is never the only signal. */
const LABELS: Record<MarkerKind, { text: string; name: string }> = {
  new: { text: "新", name: "New Word" },
  fumble: { text: "△", name: "Fumble" },
  grammar: { text: "文", name: "Grammar Point" },
};

interface OpenGloss {
  marker: Marker;
  anchor: HTMLElement;
}

/**
 * Render a turn's text with its inline markers, and open a gloss on tap.
 *
 * Markers carry character ranges resolved server-side, so the text between them
 * is exactly what the model said. A tap never pauses the conversation: the
 * popover reads out of the turn that is already on screen.
 */
export function AnnotatedText({ text, markers }: { text: string; markers: Marker[] }) {
  const [open, setOpen] = useState<OpenGloss | null>(null);
  const show = useCallback((marker: Marker, anchor: HTMLElement) => {
    setOpen({ marker, anchor });
  }, []);

  if (markers.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const marker of markers) {
    if (marker.start > cursor) {
      parts.push(<span key={`t${marker.id}`}>{text.slice(cursor, marker.start)}</span>);
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
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
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
