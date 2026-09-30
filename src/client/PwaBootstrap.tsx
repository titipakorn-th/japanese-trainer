"use client";

import { useEffect } from "react";

/**
 * Register the service worker, in production only.
 *
 * The worker is what makes the app installable, and it is deliberately blind to
 * the conversation itself — see `public/sw.js`. Registration is gated on
 * production because development build output is not content-hashed: a cached
 * chunk there is a stale chunk, and every edit would turn into a debugging
 * session about the cache rather than about the change.
 *
 * Failures are swallowed. A browser that refuses to register a worker — private
 * mode, an unsupported engine, a blocked scope — has lost the home-screen
 * install and nothing else, and that is not worth interrupting a conversation
 * to tell the learner about.
 */
export function PwaBootstrap() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = (): void => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };

    // Registering on `load` keeps the worker's own fetches off the critical path
    // for the first paint — which is the path the ten-second budget is written
    // against.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
