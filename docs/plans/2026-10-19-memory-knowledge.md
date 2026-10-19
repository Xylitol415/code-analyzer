# Memory and reviewed project knowledge

Approved in chat on 2026-10-19; implementation starts at ea53e3e on codex/fix-session-lifecycle.

## Binding decisions

- Local single-user deployment; shared existing Bearer token, anonymous feedback, no account system.
- pi remains responsible for short-term history and compaction. Independent `src/memory` owns reusable knowledge.
- File SQLite is authoritative; optional pinned zvec 0.7.1 is a rebuildable BM25/Chinese FTS index. No online/local embedding.
- Only human-published static-code answers are reusable. Exact reuse only on a session's first real user question; later questions may use approved evidence.
- Source revision includes canonical project, branch and full HEAD. Dirty/untracked/unsupported hidden Git states disable reuse. Fixed Git blobs are the publication evidence. Status checks are not an atomic filesystem snapshot.
- Code changes or used knowledge withdrawal require a new conversation; preserve the original historical transcript.
- Web provides feedback and a Tailwind review dialog. REPL shares the same module and supports status/search/bypass/feedback.
- Each process uses a worker for native I/O. Every zvec operation uses a cross-process project lock, open/operate/close; never hold it during LLM work.
- Reviewed status and outbox commit together. Search returns immutable IDs and revalidates authoritative state.
- Public types and cross-task contract: `src/memory/types.ts`. All service methods are async. Errors expose status 400/404/409/503 as appropriate.

## Task 1: Native index and persistence

Verify the real native package on this machine before enabling. Test FTS-only jieba, update/delete, reopen, cross-process locks and worker responsiveness. Index adapter implements `KnowledgeIndex`; retries/outbox are owned by engine. Each project collection contains ID, sourceKey, policyHash, searchText. Use literal `matchString`, not user-authored query syntax. Query IDs are revalidated in SQLite. Loading failures degrade to ordinary analysis.

SQLite uses node:sqlite (memory feature Node >=22.13, core still supports older Node). Store answer records, immutable knowledge revisions, feedback, outbox and pending reuse operations. State mutations use transactions/CAS. Publish reads fixed commit evidence, rejects changed source, requires nonempty conditions and valid tracked-file evidence. No automatic LLM extraction. Final positive feedback creates candidate, not publication. Incorrect/outdated exact-answer feedback suspends its source revision. Candidate versions remain traceable.

## Task 2: pi runtime

Attach memory binding at session construction, retaining original transformContext. Before prompt refresh Skills, derive actual system/Skills/model policy hash, snapshot source. Exact reuse uses first independent question, matching source/policy/question and published knowledge. Later questions: retrieve up to 5, inject whole entries up to 3 / 1500 estimated tokens; preserve original transformer and tool-call pairing. Clear per-turn projection in finally. Source changes/withdrawal after prior successful turn cause a typed stale-context error and new-session prompt.

Use final settled canonical assistant message rather than concatenated text_delta as authoritative completed answer. Preserve intermediate thinking/tool display. Stable backend answer ID/version and custom transcript metadata unify SSE and history. Collect usage with quality flags (custom endpoint may not report; never label unknown as zero).

Exact replay: durable SQLite pending -> begin marker -> real user + assistant -> completion metadata -> refreshContext -> SQLite complete -> done. No await inside transcript append group. Reconcile pending from persisted transcript; incomplete or conflicting leaf marks interrupted rather than blindly adding messages. requestId is scoped to history and full question; conflict is 409. Completed retry does not duplicate history. Errors/cancellations are not trusted knowledge.

## Task 3: HTTP and REPL

Routes under `/memory`: GET knowledge list/detail, POST candidate, PUT answer feedback, POST review. Existing ask accepts requestId and reuse auto/bypass; adds source and answer metadata to JSON/SSE done. History returns stable metadata, legacy history remains readable. Typed stale context produces actionable SSE/JSON details. No external source reads/writes beyond validated Git project and app data.

REPL implements `/memory`, `/memory search`, `/memory bypass`, `/feedback up|down|clear`. Uses same service, fresh canonical scope, no separate caches. All native workers close/unref correctly on lifecycle end. Core failures retain existing cleanup and Ctrl+C semantics.

## Task 4: Web

Keep current Tailwind design. Copy-adjacent feedback after successful completion; fixed local welcome, no greeting LLM call. Sources and stale state visible. New knowledge topbar entry with candidate/published/review tabs, immutable source evidence, question/answer/conditions editable, source revision shown, publish/revise/suspend/withdraw with CAS. Scope bound to actual session backend/project; stale async operations cannot update a new binding. Feedback random client ID only; never store credentials.

Prompt user to start fresh when context stale, preserve unsent question and old history. Existing clients remain compatible with optional metadata. API client adds typed memory requests; frontend no import of backend runtime.

## Task 5: Verification, evaluation and documentation

Test durable positive/negative/clear feedback, CAS conflicts, project/revision/policy isolation, same-vs-different questions, dirty source, negative conditions, revoked IDs, empty/failing index, concurrent SQLite/outbox, cache first turn->restore->follow-up, request retry, cancel and staged-write recovery. Root existing session/Skills/Git/model gates remain green. Web new interaction regressions plus existing suite/build.

Create reproducible 20 question-family / 8 scenario evaluation fixtures and scripts with explicit expected reuse boundaries, source variants, separate dev/acceptance families. Benchmark cold/hot native index (1k/10k) and repeat trials, record results rather than promise gains. Full real-model/business accuracy needs maintainer labels; no paid model invocation without an existing configured test fixture, no fabricated Recall@5 or token savings. Unknown usage reported separately. Exact hit must make 0 model calls. Native run benchmarks and report P50/P95, lock behavior and event-loop responsiveness. README documents setup, feedback/review, strict invalidation, downgrade and opt-out.

## Ownership

- Store agent: types, source.ts, engine.ts, service.ts, worker entry, store tests; may refine additive types with notification.
- Runtime agent: memory/runtime.ts, ask.ts, session-factory.ts, session-history.ts, runtime tests.
- Web agent: web sources/tests, knowledge/feedback UI, static greeting.
- Root: index.ts and native probes, memory-routes.ts, server/repl integration, evaluation/docs, integration and review.

No auto commit/push. Existing untracked research notes are retained.
