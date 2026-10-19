# Memory store implementation report

Implemented `src/memory/source.ts`, `engine.ts`, `service.ts`, `worker.mjs`, and `errors.ts`. Existing shared `types.ts` was sufficient and remains unchanged.

SQLite is authoritative at `<application-data>/memory/state.sqlite`, using WAL, FULL synchronous writes, busy timeout, immediate transactions, immutable knowledge version rows, current-revision CAS, anonymous feedback, a durable index outbox, answer/request identity constraints, and pending replay records. Reviews commit the new version and outbox together. Exact lookup works while the optional index is unavailable. Search validates index IDs against current published SQLite versions and source/policy scope. Failed index synchronization leaves outbox operations durable for replay.

Publication requires nonempty conditions, the same clean canonical repository/branch/HEAD, regular tracked Git blob ranges, and another source check after reading evidence. All Git operations use the existing read-only invocation helper. Canonical realpath identifies project aliases. Dirty/untracked files, assume-unchanged, skip-worktree and other hidden flags, submodules, symlink evidence, traversal, and out-of-range evidence disable publication or reuse.

The asynchronous facade creates one lazy worker per service. SQLite, Git and index operations execute there; idle workers are unreferenced and requests reference their worker until settled. Explicit close drains queued operations, closes storage/index, and closes the worker port. Errors retain MemoryError status across RPC. `getMemoryService()` disables memory when opted out or Node is older than 22.13; `createMemoryService({dataDir})` supports isolated fixtures. Data roots respect CODE_ANALYZER_DATA_DIR.

Positive feedback creates candidates. Incorrect/outdated negative feedback on exact answers suspends the actually used immutable current version; feedback about an older version does not suspend its replacement. Completion of pending replay preserves already-recorded settled transcript entry IDs. `needsreview` lists suspended entries and published entries whose source no longer applies.

## Verification

Observed initial failing assertions with absent engine/facade before implementation. Also observed the pending-completion enrichment and needsreview tests fail against the first implementation before fixing them.

`node --import tsx --import ./tests/test-env.ts --test tests/memory-store*.test.ts`: 10 passed, 0 failed. Covers persistence/reopen, immutable versions, review CAS, exact/question/policy scope, candidate feedback/idempotence/clear, suspension, dirty/hidden Git states, fixed blob evidence, canonical aliases, changed commits, pending retry conflicts/interruption/recovery, index failure/outbox recovery, SQLite validation of forged index IDs, concurrent reviewers, replacement version protection, and main event-loop progress while the worker starts.

The root agent owns the final project-wide test run; concurrent tasks were still being implemented when focused verification ran. The first typecheck reported only concurrent index/runtime implementation errors outside store ownership. A follow-up typecheck is recorded in the parent handoff.

## Limits

Git status plus before/after checks are not an atomic filesystem snapshot. Search index availability and native package correctness are owned by the root adapter task. Native index rebuild requires replaying authoritative published SQLite entries if the index directory is removed; current engine outbox recovers unacknowledged changes, not acknowledged rows lost from an independently deleted index. No model calls were made by store tests.
