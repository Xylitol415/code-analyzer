# Memory final correctness fixes

Implemented on the existing uncommitted feature branch on 2026-10-19. No commit or push was made.

## Changes

- Outbox flush now takes a per-project `proper-lockfile` lease under `dataDir/memory/flush-locks` before reading queued changes, holds it through index sync and acknowledgment, and releases it afterward. The lease precedes the native index lock. Failed sync leaves outbox rows intact.
- `beginReuse` validates the exact knowledge version, publication state, source snapshot, and policy inside its SQLite transaction. Replay also validates source and knowledge after transcript append. A failed or unavailable final validation writes a durable stale marker.
- A source or knowledge change during generated completion writes a durable `answer_context_stale` transcript marker. Subsequent asks, bypass requests, and restored sessions return 409 before any model call.
- `runAsk` propagates semantic and unexpected preparation errors. Only typed `MemoryError` 503 falls back to ordinary analysis before replay append.
- Transient evidence budgeting counts the full serialized entry, including source evidence text and envelope, and avoids duplicate revision IDs.
- Generated answers with missing, invalid, or all-zero token deltas report null usage with `unknown` quality. Exact replay retains `no-model-call` zero usage.
- Knowledge dialog review completion clears its busy state after close, allowing a reopened dialog to operate.
- Generated or assisted completion now records a durable `validation_unavailable` stale marker if its final snapshot or knowledge validation throws after the model has written a settled answer.
- An initial unsupported Git snapshot (`MemoryError` 400) allows ordinary analysis before any completed memory history exists. A failed snapshot after trusted memory history marks that conversation stale. An initial 503 still falls back to ordinary analysis before trusted history.
- The flush lease uses the same roughly six second retry window as the native index lock, while retaining outbox rows on lock or sync failure.
- A failed used-knowledge check or replay-journal read after trusted history also records a durable stale marker. This closes the other storage-error paths that could have fallen through to a model call.
- A failed replay-journal read also blocks continuation when the transcript has an incomplete `answer_reuse_begin` marker but no completed record yet.
- New feedback and knowledge controls explicitly clear native button chrome. A scoped knowledge-row rule restores stacked, left-aligned question and metadata text inside the toolbar dialog while retaining slate and indigo states.

## Verification

Red regressions were observed for outbox ordering, withdrawn replay, durable stale state, semantic error propagation, evidence sizing, zero usage, and dialog busy state before the fixes.

| Command | Result |
| --- | --- |
| `node --import tsx --import ./tests/test-env.ts --test tests/memory-runtime.test.ts tests/memory-store.test.ts` | 41/41 pass |
| `node --import tsx --import ./tests/test-env.ts --test tests/skills-runtime.test.ts tests/skills-http.test.ts` | 9/9 pass |
| `npm run typecheck` | pass |
| `cd web && node --import tsx --test test/memory-ui.test.mjs` | 7/7 pass |
| `cd web && npm run build` | pass |

The full root suite was outside this focused pass; the coordinating agent is running broader verification. The web build emitted Vite's existing large chunk advisory and no build error.
