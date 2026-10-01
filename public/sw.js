/**
 * The service worker.
 *
 * This app's whole point is that the server owns the session: a turn and the
 * partner's reply commit together, a reload resumes from the database, and the
 * end-of-session summary is a projection of what is actually on disk. A cache
 * sitting in front of any of that would show the learner a conversation that
 * does not match the one the server holds — and the mismatch would be silent,
 * which is the one failure mode this project cannot have. So almost nothing here
 * is cached: the API, the session pages, and every turn stream go straight to the
 * network, and there is no offline version of a conversation because there cannot
 * honestly be one.
 *
 * What the worker is actually for is being installable and being honest when the
 * server is gone. It precaches the shell so the app opens from a home screen
 * without a white flash, and it answers an unreachable server with a page that
 * says so, rather than the browser's own error or a stale transcript. See
 * `docs/adr/0012-pwa-installability.md`.
 *
 * Registered only in production. In development the build output is not
 * content-hashed, so a cached chunk is a stale chunk and every edit becomes a
 * debugging session about the cache instead of about the change.
 */

/** Bump on any change to this file or to the precache list, to retire old caches. */
const VERSION = "jt-v1";
const SHELL = `${VERSION}-shell`;

const PRECACHE = [
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One bad URL must not leave the worker permanently uninstalled, so a
      // failure to fetch a precache entry does not abort the install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Content-hashed build output: a cached copy is always the right copy. */
const isImmutableAsset = (path) =>
  path.startsWith("/_next/static/") ||
  path === "/favicon.png" ||
  path.startsWith("/icon") ||
  path === "/apple-touch-icon.png";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live server state. Nothing here is ever served from a cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/session/")) return;

  if (request.mode === "navigate") {
    // Network first, always. A page that renders from a cache when the server is
    // up would be a page describing a session the server has since changed.
    // Falling back to the offline notice is the only offline response the app
    // can give honestly, and it is a real answer to "is the app down?" rather
    // than a dead end.
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match("/offline.html", { cacheName: SHELL })
          .then((hit) => hit ?? Response.error()),
      ),
    );
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
