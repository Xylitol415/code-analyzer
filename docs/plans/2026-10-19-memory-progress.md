# Progress — plan: docs/plans/2026-10-19-memory-knowledge.md

Base: ea53e3e10992f22d90fab7437dc3866e6d0ffd39; checkout codex/fix-session-lifecycle.

## Preflight

| Tasks | Shared interface | Resolution |
|---|---|---|
| Index / store | KnowledgeIndex and IndexChange | types.ts is the contract; SQLite owns outbox and final validity |
| Store / runtime | MemoryService and AnswerRecord | async facade; worker owns native calls; no LLM work under locks |
| Runtime / web / HTTP | AnswerMetadata, requestId, reuse | optional wire fields; stream UI uses done for authoritative identity |
| Runtime / history | answer_completed custom metadata | visible user/assistant preserved; old histories supported |
| Review / source | immutable commit evidence | human publishes; dirty state cannot silently publish |
| All tasks | existing checkout and original scope | continue authorized current feature branch; no automatic commits/push |

## Status

- Baseline: root 85/85, web 82/82 passed.
- Native @zvec/zvec0.7.1 installed as optional dependency; Chinese FTS/update/delete/reopen/scope and lock-facade tests 3/3 passed.
- Persistence agent delivered SQLite/source/outbox/worker, 10 focused tests passed. Its account quota stopped follow-ups; root owns remaining work.
- Runtime agent delivered pi hooks/cache/journal/history and initial tests; root corrected evidence system-message elevation, first-question semantic retrieval, and unchanged dirty-checkout continuation. 14 runtime tests passed after red regressions.
- Web agent delivered knowledge/feedback UI and no-model welcome; account quota interrupted final polish. Root owns remaining work.
- HTTP/routes and stable metadata integration delivered. End-to-end publish -> zero-model reuse -> history restore -> stale context test passed.
- REPL memory/search/bypass/feedback commands added; focused command test passed.
- Root completing explicit source revalidation/preview, feedback persistence, index reseed, native cross-process/performance probe, final verification.
- No production model calls, commits or pushes performed.

## Final verification progress

- Fixed review findings with red regressions: cross-process outbox ordering, generated/replayed stale-context durability (including unavailable final validation), request conflict propagation, full evidence size accounting, unknown usage, and dialog busy state. Scoped re-review reports no remaining concrete P1/P2 in these fixes.
- Native 5/5 tests passed including independent process writers and >1024 document rebuild; worker deleted/corrupt index recovery passed.
- 20-family/8-scenario native boundary fixture 160/160 passed; 1k/10k, 5 cold process benchmark stored under docs/evaluation. These are synthetic boundary/performance fixtures, not real business accuracy evidence.
- Browser verified candidate from upvote, fixed Git source preview, publication, new-session exact reuse with model call count unchanged, and source invalidation. Own isolated test ports 8897/5176; user port 5173 untouched.
- Web 96/96 passed and production build passed. Full root default concurrency exposed provider cancellation timeout under native startup CPU load; isolated cancellation passed. Checking full suite with bounded concurrency before choosing a stable test harness budget.
- Existing pi transitive brace-expansion audit finding recorded; no unrelated dependency upgrades.

## Completion

- All five approved task areas implemented. Final `npm test`: 137/137; web tests: 96/96; root typecheck and web production build pass. Final boundary evaluation: 160/160. Diff whitespace check clean.
- Test runner uses at most four file processes to avoid native initialization starving the existing 3s cancellation gate; cancellation assertions remain unchanged. Native cross-process locks remain explicitly tested.
- Added final unavailable-journal/incomplete-replay regression: no model invocation is allowed when recovery cannot prove the transcript is complete.
- Instructions: docs/memory.md. Evidence and limitations: docs/evaluation/2026-10-19-memory-verification.md plus machine-readable outputs.
- No production model calls or automatic commit/push. Own browser tab and isolated test services are cleaned up; pre-existing services remain untouched.

## Subsequent frontend fixes

- Consolidated ratings into an icon menu with hover/focus help; knowledge actions share book icons and the existing Tailwind style. Web suite now contains 98 passing cases.
- Fixed long-history page overflow: the absolute screen-reader copy status lacked a positioned ancestor. The copy wrapper now contains it. The actual App browser fixture restores 40 messages and verifies document height stays at 677px while 7787px of chat content remains scrollable; before the fix the document incorrectly grew to 7828px.
- Reproducible browser regression fixture: web/test/fixtures/history-layout.html. No real backend or model is accessed.
- User requested committing the completed work to the current local branch on 2026-10-19.
