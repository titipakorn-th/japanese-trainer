# 11. The service worker caches nothing about the conversation

Date: 2026-10-01
Status: accepted

Numbered 0011, not 0008, for the reason given at the top of ADR 0010: 0007 and
0008 were claimed by three branches at once and the sequence was made
contiguous. See issue #15.

## Context

Issue #11 asks for the app to be installable as a PWA and to open from a home
screen on the learner's Mac and phone from one URL, alongside a reload that
resumes mid-session.

Those two asks pull against each other. Installability wants a service worker
with a fetch handler and a precache — that is what a browser looks for before it
offers "Add to Home Screen". But this app's entire value rests on the server
owning the session: a learner's turn and the partner's reply commit in one
transaction (ADR 0003), a reload resumes from the database, and the end-of-session
summary is a projection of what is actually on disk (ADR 0010). Every one of
those is a promise that what the browser shows is what the server holds.

A service worker is the one component in the stack that can quietly break that
promise. Put a cache in front of `/api/sessions/*/turns` and a learner gets a
transcript that disagrees with the record — no error, no banner, just a
conversation that is subtly wrong. The failure would be silent, and silent is the
one failure mode this project cannot have.

## Decision

**Install the worker so the app can be added to a home screen. Cache nothing that
belongs to a session.**

### The manifest and the icons

`public/manifest.webmanifest` declares `display: "standalone"`, the app's own name
and icon, and a background and theme colour of `#0b0d10` so an installed app does
not flash white on open. `icons` carries 192 and 512 as `any` and a separate
512 as `maskable`, because Android masks to a circle and a square icon loses its
corners without the maskable variant.

`layout.tsx` repeats the intent in the `appleWebApp` block. iOS ignores the
manifest and reads those meta tags instead, and iOS is half of the "Mac and
phone" promise, so without them an iPhone install gets a browser title bar and a
generic icon. `statusBarStyle: "black-translucent"` lets the app paint under a
notched status bar rather than starting below it.

### The cache rules

`public/sw.js` handles three kinds of request, and the default is *do not
intervene*:

- **`/api/*` and `/session/*` are never cached.** Not stale-while-revalidate,
  not cache-first. The turn stream and the rendered session page are live server
  state, and the worker's only correct behaviour is to get out of the way.
- **Navigations are network-first, with one fallback.** If the network fails, the
  worker answers with `offline.html`. Never the cached page: a page rendered from
  a cache while the server is up would be a page describing a session the server
  has since changed.
- **Content-hashed build output is cache-first.** `/_next/static/`, the icons and
  the favicon. A hashed filename is immutable by construction, so a cached copy
  is always the right copy, and this is what makes an installed app open from the
  home screen without a white flash.

`VERSION` is a constant in the worker; bumping it retires the previous cache on
activate.

### Registration is production-only

`PwaBootstrap` registers the worker only when `process.env.NODE_ENV ===
"production"`. In development the build output is not content-hashed, so a cached
chunk is a stale chunk, and every edit would turn into a debugging session about
the cache rather than about the change. Registration also waits for `load`, to
keep the worker's own fetches off the critical path the ten-second budget is
written against.

### The offline page is a real answer

`offline.html` says the app cannot reach the server, says that nothing has been
lost because the sessions are local, and gives the one thing the learner can
actually do — start the app, then retry. It is deliberately not an empty shell and
not a cached session: issue #11 asks for errors clear enough to know whether to
retry or whether the app is down, and an offline notice that says which is
exactly that.

## Consequences

- **The app is installable on Mac and phone from one URL**, and the installed
  app opens on the app's own icon and colour rather than in a browser frame.
- **There is no offline conversation, and there cannot honestly be one.** A
  cached transcript is not a practice session; it is a screenshot of one. The
  worker is for being installable and for answering "is the app down?".
- **A regression here is silent and expensive.** A cache rule that drifts to
  cover `/session/` produces a learner looking at a conversation the server has
  moved past. The rule is enforced by an early return in the fetch handler, ahead
  of the caching branches, so widening it takes a deliberate edit.
- **The ten-second budget needed measuring rather than asserting.** Issue #11
  promises a session starts in under ten seconds from a cold load;
  `scripts/probe-cold-start.ts` walks the same path the browser does against a
  real server and prints the breakdown. It cannot see the browser's own work —
  downloading, parsing and hydrating roughly 220KB of JavaScript before the
  opening turn can even be requested — so it prints that size alongside the
  total rather than pretending to be the whole number, and the number to trust is
  the one measured in a browser. Against a production build the browser
  measurement was ~1.7s and the probe's server-side path ~3.6s, both well inside
  the budget.
