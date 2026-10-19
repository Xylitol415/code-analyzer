# Project Skills implementation

Implements the user's approved pi 0.87.1 Skills plan (2026-10-19).

## Global constraints
- Project analysis remains read-only. Only explicit host confirmation publishes a skill.
- Shared HTTP and independent REPL service, explicit project bindings, immutable hash versions, atomic locked changes.
- Upload SKILL.md / single-skill ZIP, public HTTPS and GitHub directory, and discovered local pi/.agents candidates.
- Preview bound to canonical project and fixed files, expires after 15 minutes; confirmation idempotent.
- Public HTTPS DNS/redirect validation; 20 MiB compressed/uncompressed, 200 files, 256 KiB SKILL.md. Reject ZIP traversal/symlinks.
- Only project-enabled skills reach pi. Refresh before next queued turn via public SDK tool/system-prompt update, never session.reload(). Preserve model runtime and history.
- Web Tailwind management dialog and conversation confirmation cards; REPL commands and post-turn confirmation. Model may prepare, never confirm.
- Skill allowed-tools cannot grant privileges; no scripts, extensions, hooks, pi install or npm/Git package installation.

## Tasks
1. Shared types; secure importer, immutable store, local discovery, locks, tests.
2. Controlled ResourceLoader, prepare tool, next-turn snapshot + audit, REPL commands/confirmation, tests.
3. Web manager and upload/URL/local previews, confirmation cards, applied state, tests.
4. HTTP integration, Git argument hardening, documentation, integration and browser verification.
5. Task and final reviews; fix concrete findings; full regression gates.

## Acceptance
Import completeness/validation/TTL/idempotence; actual next-turn and explicit skill invocation; project and concurrent process isolation; scripts never execute; network and archive boundaries; persistent restart; web/REPL flows; existing cancellation/history/model isolation gates.

## Delivered and verified

- Shared secure importer/store and project snapshots; controlled pi loader; prepare-only model tool; HTTP/SSE integration; web management and conversation confirmation; REPL host commands and post-turn confirmation.
- Immutable content versions, atomic locked publication, stale-preview conflict checks, idempotency, fixed byte ordering, bounded archives/downloads, public DNS pinning and redirect validation.
- Git argument grammar plus neutralization of external filters, textconv/diff, signature verification formatters, and automatic helper paths.
- Final backend suite: **85 passed**. Web suite: **75 passed**. Backend typecheck, frontend production build and `git diff --check` passed.
- Native SDK verification checks prompt discovery/explicit expansion, current project state after historical restore, model isolation, per-turn audit, cancellation and disabled invocation.
- Browser verified local import, conversation preview/confirmation, actual upload via native file picker, and next-turn applied count. REPL verified with buffered non-TTY flow and a real PTY confirmation flow. Temporary servers/data were removed.
- Reviewed and fixed stale same-version confirmation, inherited version keys, locale-dependent hashes, older-version selector reset, and canonical path identity mismatch. Final review has no unresolved P1/P2.
- Live public GitHub download smoke was blocked by local fake-IP DNS (`api.github.com` mapped into reserved `198.18.0.0/15`); the guard was preserved. Transport/redirect/GitHub fixture tests pass. File/ZIP upload is the local fallback; public real-IP DNS is required for remote import.

Existing session-release and favicon work in the checkout was preserved and is included in the same branch delivery.
