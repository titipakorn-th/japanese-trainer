# 9. A cold start migrates the store under a write lock

Date: 2026-10-01
Status: accepted

## Context

`src/server/db.ts` opens the store and migrates it at module scope, so importing
it is what creates and upgrades the file. `next build` collects page data with a
pool of workers and every one of them imports that module, which means the first
build in a fresh clone — the first thing a new contributor ever runs — is a dozen
processes creating and migrating one non-existent SQLite file simultaneously.

SQLite serialises writers, so the file cannot be corrupted. What it can do is
reject a statement that was decided on a stale read, and both of the ways this
went wrong fail as a *schema* error, so the cause reads as "the schema is wrong"
rather than "two processes raced":

- `migrate()` read `PRAGMA table_info` and then `ALTER`ed, with no lock in
  between. Two workers could both conclude `turn.sprint_id` was missing; the
  winner added it and the loser died with `duplicate column name: sprint_id`.
- `PRAGMA journal_mode = WAL` fails the same way, and worse: changing journal
  mode needs an exclusive lock, and SQLite returns `SQLITE_BUSY` for it *without
  consulting the busy handler*. Measured at 0ms against a held write lock, and
  succeeding 1ms after that lock was released. No busy timeout can fix it, and no
  amount of retrying a stale intent helps either.

The second one was not visible until the first was fixed. Making the migration
atomic lengthened the write-lock window, so workers that used to arrive after it
had closed now arrived during it — a real cold `next build` failed on
`database is locked` before this change and passes after it.

## Decision

**The schema and the migration run as one `IMMEDIATE` transaction, taken at
`open`, and WAL is established before that lock is requested.**

`immediate` acquires the write lock at `BEGIN` rather than at the first write, so
the column re-reads inside `migrate()` observe the winner's committed state
instead of the shape that was there when the process started. Everything inside
stays idempotent, so the workers that arrive second find the work done.

The ordering of the two is load-bearing rather than incidental. Journal mode lives
in the file header, so the worker holding the write lock put the store into WAL
*before* it took that lock. A worker blocked at `journal_mode` can therefore
resolve by re-reading what the store already is, instead of writing it. Swap the
two and the re-read stops being sound: the blocked worker would be looking at a
store whose winner had not switched it yet.

The migration stays at module scope.

## Consequences

- A cold build no longer depends on a store that does not exist yet behaving like
  a store that does. A fresh clone migrates the same way a returning one does.
- Every future migration is still a check-then-act and is safe for the same single
  reason: the caller holds the lock. A migration invoked from anywhere that does
  not will reintroduce exactly this bug, which is why `migrate` says so.
- `busy_timeout` is set explicitly. It is what lets the *losers* of a contended
  migration wait instead of failing, and it is the only reason the WAL case is
  special-cased at all.
- A blocked `journal_mode` is retried by re-read rather than by sleeping. The
  window is the length of one migration, so this is a bound on a race, not a
  timeout; anything larger would be hiding a hang.
- The store's shape is now decided by whichever worker wins the lock, and the
  losers contribute nothing. Since the work is idempotent, which worker that is
  does not matter.
- Nothing about the single-learner case changed. The dev server opens one store
  and contends with nothing.

## Rejected

- **Hoisting the migration into a build step.** The issue raises it, and it is
  the wrong trade. It narrows the window rather than closing it — the dev server
  opens the store too, and any route that opened it without migrating would fail
  the same way. It also splits "the store is current" from "the store exists",
  which is the one property that makes a fresh clone work with no extra step.
- **A `busy_timeout` alone.** It is necessary and not sufficient: it makes the
  losers of a contended migration queue, but it cannot touch `journal_mode`, which
  never consults the handler.
- **Ignoring the `SQLITE_BUSY` from `journal_mode` and carrying on.** The store
  would silently stay in rollback-journal mode on that worker, so one process in
  the pool would read a different locking regime from the rest. Latent, and
  exactly the kind of divergence that surfaces later as an unexplained lock.
- **Catching the duplicate-column error and treating it as success.** It would
  hide a genuine race, and the losing worker would have no way to know whether the
  other worker's `ALTER` was the one that landed.
