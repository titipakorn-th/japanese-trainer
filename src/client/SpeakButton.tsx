"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Replay one partner line out loud.
 *
 * Every button shares a small URL cache, so hearing the same line twice costs
 * one fetch. The bound is deliberately small and eviction revokes: these are
 * blobs in memory, and an unbounded map keyed on arbitrary text is a leak that
 * only shows up on a long session.
 */
const URL_CACHE_LIMIT = 6;
const urlCache = new Map<string, string>();

/**
 * Only one line plays at a time.
 *
 * A module-level handle rather than per-button state, because the buttons are
 * siblings with no shared owner: a learner who taps a new line while an old one
 * is talking expects the old one to stop, and the only component that can do
 * that is the one that started it.
 */
let stopCurrent: (() => void) | null = null;

function cachedUrl(text: string): string | undefined {
  return urlCache.get(text);
}

function rememberUrl(text: string, url: string): void {
  urlCache.set(text, url);
  while (urlCache.size > URL_CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const stale = urlCache.get(oldest);
    urlCache.delete(oldest);
    if (stale) URL.revokeObjectURL(stale);
  }
}

type Phase = "idle" | "loading" | "playing" | "silent";

export function SpeakButton({ text }: { text: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectRef = useRef<string | null>(null);
  const cancelled = useRef(false);
  const resetTimer = useRef<number | null>(null);

  // Anything this component made, released when it goes away. Without this a
  // reload mid-playback leaks an object URL and a decoded MP3 per turn.
  //
  // The flag is cleared on the way in, not left at its initial value. React runs
  // a cleanup before every re-run of an effect, so a component whose `text`
  // changes — or one mounted twice under StrictMode, which is the default in dev
  // — would otherwise come back from cleanup permanently "cancelled" and refuse
  // to ever play, with nothing in the console to say why.
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      audioRef.current?.pause();
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
      if (objectRef.current && !cachedUrl(text)) URL.revokeObjectURL(objectRef.current);
    };
  }, [text]);

  const play = useCallback(async (url: string) => {
    stopCurrent?.();
    const audio = new Audio(url);
    audioRef.current = audio;

    const finish = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPhase("idle");
      }
      if (stopCurrent === release) stopCurrent = null;
    };
    const release = () => {
      audio.pause();
      finish();
    };
    stopCurrent = release;

    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    try {
      await audio.play();
      if (cancelled.current) {
        audio.pause();
        return;
      }
      setPhase("playing");
    } catch {
      // The browser refused to start playback. There is nothing to recover and
      // nothing to tell the learner, so this lands back on idle.
      finish();
    }
  }, []);

  const onClick = useCallback(async () => {
    // The button is disabled while synthesising, so the only state a tap can
    // arrive in here is `playing` — and the only thing to do in that state is
    // stop. A stop branch that also claimed to cover `loading` would be dead
    // code, and a branch that covered nothing would be a double fetch.
    if (phase === "playing") {
      stopCurrent?.();
      return;
    }

    const hit = cachedUrl(text);
    setPhase("loading");
    try {
      let url = hit;
      if (!url) {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(String(response.status));
        url = URL.createObjectURL(await response.blob());
        if (cancelled.current) {
          URL.revokeObjectURL(url);
          return;
        }
        objectRef.current = url;
        rememberUrl(text, url);
      }
      await play(url);
    } catch {
      // No speech is a worse session, not a broken one. The text is all there;
      // say nothing and let the learner carry on. The timer is cleared by the
      // unmount cleanup, so this cannot set state on a button that is gone.
      setPhase("silent");
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null;
        if (!cancelled.current) setPhase("idle");
      }, 1200);
    }
  }, [phase, play, text]);

  const label =
    phase === "loading" ? "Speaking…" : phase === "playing" ? "Stop" : phase === "silent" ? "No audio" : "Play";

  return (
    <button
      type="button"
      className="speak"
      data-phase={phase}
      onClick={onClick}
      // Unreachable from the keyboard as well as the pointer, which is the point:
      // a second synthesis started while the first is in flight would bill the
      // learner twice for a line they already asked for.
      disabled={phase === "loading"}
      aria-label={phase === "idle" ? "Hear this line" : label}
    >
      <span aria-hidden="true">{phase === "loading" ? "…" : phase === "silent" ? "×" : "▶"}</span>
    </button>
  );
}
