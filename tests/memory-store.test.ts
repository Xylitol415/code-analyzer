import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AnswerRecord, KnowledgeIndex, IndexChange } from '../src/memory/types.js';

async function setup(t: any, failIndex = false) {
  const mod = await import('../src/memory/engine.js').catch(() => undefined);
  assert.equal(typeof mod?.MemoryEngine, 'function', 'durable memory engine must be available');
  const root = mkdtempSync(join(tmpdir(), 'memory-store-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'logic.ts'), 'export const value = 1;\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
  const docs = new Map<string, any>();
  const index: KnowledgeIndex = {
    async sync(_project, changes) { if (failIndex) throw new Error('offline'); for (const c of changes) c.op === 'delete' ? docs.delete(c.id) : docs.set(c.id, c.document); },
    async search() { if (failIndex) throw new Error('offline'); return [...docs.keys()]; },
  };
  const engine = new mod!.MemoryEngine({ dataDir: join(root, 'data'), index });
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }); });
  const snapshot = await engine.snapshot(repo);
  const answer: AnswerRecord = { id: 'answer-1', version: 'v1', requestId: 'req-1', historyId: 'history-1', question: 'What is value?', answer: 'It is 1.', status: 'completed', source: 'generated', snapshot, policyHash: 'policy-1', knowledgeIds: [], assistantEntryIds: ['assistant-1'], usage: { input: null, output: null, cacheRead: null, cacheWrite: null, quality: 'unknown' }, elapsedMs: 1, createdAt: new Date().toISOString() };
  await engine.recordAnswer(answer);
  return { engine, answer, repo, root, git, index, docs, mod: mod! };
}

test('published knowledge persists with immutable versions, CAS and precise scope', async t => {
  const { engine, answer, repo, root, index, mod } = await setup(t);
  assert.equal((await engine.snapshot(repo)).clean, true);
  const candidate = await engine.createCandidate(answer.id);
  assert.equal(candidate.state, 'candidate');
  assert.equal(await engine.lookupExact({ snapshot: answer.snapshot, policyHash: 'policy-1', question: answer.question }), undefined);
  await assert.rejects(engine.review(candidate.id, { expectedRevision: 1, action: 'publish', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] }), /conditions/i);
  const published = await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'Only at this revision', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  assert.equal(published.state, 'published'); assert.equal(published.evidence[0].text, 'export const value = 1;');
  await assert.rejects(engine.review(candidate.id, { expectedRevision: 1, action: 'withdraw' }), (e: any) => e.status === 409);
  assert.equal((await engine.lookupExact({ snapshot: answer.snapshot, policyHash: 'policy-1', question: answer.question }))?.versionId, published.versionId);
  assert.equal(await engine.lookupExact({ snapshot: answer.snapshot, policyHash: 'different', question: answer.question }), undefined);
  assert.equal(await engine.lookupExact({ snapshot: answer.snapshot, policyHash: 'policy-1', question: 'different question' }), undefined);
  const restored = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  try { const item = await restored.getKnowledge(candidate.id); assert.equal(item.revision, 2); assert.equal(item.versions?.length, 2); assert.equal(item.versions?.[0].state, 'candidate'); } finally { await restored.close(); }
  const withdrawn = await engine.review(candidate.id, { expectedRevision: 2, action: 'withdraw' });
  assert.equal(await engine.validKnowledge([published.versionId]), false);
  assert.equal(withdrawn.state, 'withdrawn');
});

test('feedback up creates candidate; exact incorrect feedback suspends the actual version durably', async t => {
  const { engine, answer } = await setup(t);
  const up = await engine.feedback(answer.id, { clientId: 'client-a', vote: 'up' });
  assert.equal(up.up, 1); assert.ok(up.knowledgeId);
  assert.equal((await engine.feedback(answer.id, { clientId: 'client-a', vote: 'up' })).up, 1);
  const published = await engine.review(up.knowledgeId!, { expectedRevision: 1, action: 'publish', conditions: 'Only at this revision', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  const exact = { ...answer, id: 'exact', requestId: 'exact-request', source: 'exact' as const, knowledgeIds: [published.versionId] };
  await engine.recordAnswer(exact);
  await engine.feedback(exact.id, { clientId: 'client-a', vote: 'down', reason: 'presentation' });
  assert.equal(await engine.validKnowledge([published.versionId]), true);
  await engine.feedback(exact.id, { clientId: 'client-a', vote: 'down', reason: 'incorrect' });
  assert.equal(await engine.validKnowledge([published.versionId]), false);
  assert.equal((await engine.getKnowledge(up.knowledgeId!)).state, 'suspended');
  assert.equal((await engine.feedback(exact.id, { clientId: 'client-a', vote: null })).down, 0);
});

test('strict source rejects dirty, hidden index flags, changed HEAD and untracked evidence', async t => {
  const { engine, answer, repo, root, git } = await setup(t);
  symlinkSync(repo, join(root, 'alias'));
  assert.equal((await engine.snapshot(join(root, 'alias'))).projectId, answer.snapshot.projectId);
  const candidate = await engine.createCandidate(answer.id);
  const review = { expectedRevision: 1, action: 'publish' as const, conditions: 'Valid only here', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] };
  writeFileSync(join(repo, 'new.txt'), 'new');
  assert.equal((await engine.snapshot(repo)).clean, false);
  await assert.rejects(engine.review(candidate.id, review), (e: any) => e.status === 409);
  rmSync(join(repo, 'new.txt'));
  git('update-index', '--assume-unchanged', 'logic.ts');
  assert.equal((await engine.snapshot(repo)).clean, false);
  git('update-index', '--no-assume-unchanged', 'logic.ts');
  await assert.rejects(engine.review(candidate.id, { ...review, evidence: [{ path: '../outside', startLine: 1, endLine: 1 }] }), (e: any) => e.status === 400);
  await assert.rejects(engine.review(candidate.id, { ...review, evidence: [{ path: 'logic.ts', startLine: 1, endLine: 99 }] }), (e: any) => e.status === 400);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'next');
  await assert.rejects(engine.review(candidate.id, review), (e: any) => e.status === 409);
});

test('pending replay survives reopen and enforces history/request/question identity', async t => {
  const { engine, answer, root, index, mod } = await setup(t);
  const candidate = await engine.createCandidate(answer.id);
  const published = await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'This commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  const pending = { requestId: 'replay', historyId: 'h2', question: answer.question, originalLeaf: null, record: { ...answer, id: 'replayed', requestId: 'replay', historyId: 'h2', source: 'exact' as const, knowledgeIds: [published.versionId] } };
  await engine.beginReuse(pending);
  await assert.rejects(engine.beginReuse({ ...pending, question: 'conflicting' }), (e: any) => e.status === 409);
  const restored = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  try { assert.equal((await restored.pendingReuses('h2')).length, 1); await restored.finishReuse('replay', 'h2'); assert.equal((await restored.findRequest('h2', 'replay'))?.id, 'replayed'); assert.equal((await restored.pendingReuses('h2')).length, 0); } finally { await restored.close(); }
  await engine.beginReuse({ ...pending, requestId: 'interrupted', record: { ...pending.record, id: 'interrupted', requestId: 'interrupted' } });
  await engine.interruptReuse('interrupted', 'h2');
  assert.equal((await engine.findRequest('h2', 'interrupted'))?.status, 'interrupted');
});

test('index failure retains authoritative exact lookup and pending outbox for recovery', async t => {
  const { engine, answer, root, mod } = await setup(t, true);
  const candidate = await engine.createCandidate(answer.id);
  const published = await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'Only this code', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  assert.equal((await engine.lookupExact({ snapshot: answer.snapshot, policyHash: answer.policyHash, question: answer.question }))?.versionId, published.versionId);
  assert.equal((await engine.list(answer.snapshot.projectPath)).indexAvailable, false);
  const recovered = new Map<string, any>();
  const index: KnowledgeIndex = { async sync(_p, changes) { for (const c of changes) c.op === 'delete' ? recovered.delete(c.id) : recovered.set(c.id, c.document); }, async search() { return [...recovered.keys(), 'forged']; } };
  const reopened = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  try { assert.equal((await reopened.search({ snapshot: answer.snapshot, policyHash: answer.policyHash, question: 'value' }))[0].versionId, published.versionId); } finally { await reopened.close(); }
});

test('replay completion preserves settled transcript entry IDs already recorded', async t => {
  const { engine, answer } = await setup(t);
  const record = { ...answer, id: 'settled-replay', requestId: 'settled', historyId: 'history-2', assistantEntryIds: [] };
  await engine.beginReuse({ requestId: record.requestId, historyId: record.historyId, question: record.question, originalLeaf: null, record });
  await engine.recordAnswer({ ...record, userEntryId: 'real-user', assistantEntryIds: ['real-assistant'] });
  await engine.finishReuse(record.requestId, record.historyId);
  assert.deepEqual((await engine.findRequest(record.historyId, record.requestId))?.assistantEntryIds, ['real-assistant']);
});

test('needsreview list includes source mismatches with correct count', async t => {
  const { engine, answer, repo, git } = await setup(t);
  const candidate = await engine.createCandidate(answer.id);
  await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'Only original revision', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  assert.equal((await engine.list(repo, { state: 'needsreview' })).total, 0);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'next');
  const list = await engine.list(repo, { state: 'needsreview' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].applicable, false);
});

test('concurrent reviewers share SQLite CAS and old exact feedback cannot suspend a new revision', async t => {
  const { engine, answer, root, index, mod } = await setup(t);
  const candidate = await engine.createCandidate(answer.id);
  const other = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  try {
    const input = { expectedRevision: 1, action: 'publish' as const, conditions: 'Only this commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] };
    const results = await Promise.allSettled([engine.review(candidate.id, input), other.review(candidate.id, input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const published = await engine.getKnowledge(candidate.id);
    await engine.recordAnswer({ ...answer, id: 'old-exact', requestId: 'old-exact', source: 'exact', knowledgeIds: [published.versionId] });
    const revised = await other.review(candidate.id, { expectedRevision: 2, action: 'revise', answer: 'Value is still 1', conditions: 'Verified revised answer' });
    await engine.feedback('old-exact', { clientId: 'client', vote: 'down', reason: 'outdated' });
    assert.equal(await engine.validKnowledge([published.versionId]), false);
    assert.equal(await engine.validKnowledge([revised.versionId]), true);
    assert.equal((await engine.getKnowledge(candidate.id)).versions?.length, 3);
  } finally { await other.close(); }
});

test('strict source disables skip-worktree and submodules and rejects symlink evidence', async t => {
  const { engine, answer, repo, git } = await setup(t);
  git('update-index', '--skip-worktree', 'logic.ts');
  assert.equal((await engine.snapshot(repo)).clean, false);
  git('update-index', '--no-skip-worktree', 'logic.ts');
  symlinkSync('logic.ts', join(repo, 'link.ts'));
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'link');
  const snapshot = await engine.snapshot(repo);
  await engine.recordAnswer({ ...answer, id: 'link-answer', requestId: 'link-request', snapshot });
  const candidate = await engine.createCandidate('link-answer');
  await assert.rejects(engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'This code', evidence: [{ path: 'link.ts', startLine: 1, endLine: 1 }] }), (e: any) => e.status === 400);
  git('update-index', '--add', '--cacheinfo', `160000,${snapshot.commit},submodule`);
  assert.equal((await engine.snapshot(repo)).clean, false);
});

test('exact matching preserves significant internal whitespace and a duplicate publication replaces the old answer', async t => {
  const { engine, answer } = await setup(t);
  await engine.recordAnswer({ ...answer, id: 'spaces', requestId: 'spaces', question: 'What does "a  b" mean?' });
  const item = await engine.createCandidate('spaces');
  const first = await engine.review(item.id, { expectedRevision: 1, action: 'publish', conditions: 'This commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  assert.equal(await engine.lookupExact({ snapshot: answer.snapshot, policyHash: answer.policyHash, question: 'What does "a b" mean?' }), undefined);
  await engine.recordAnswer({ ...answer, id: 'replacement', requestId: 'replacement', question: item.question, answer: 'Corrected answer' });
  const replacement = await engine.createCandidate('replacement');
  const second = await engine.review(replacement.id, { expectedRevision: 1, action: 'publish', conditions: 'This commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  assert.equal(await engine.validKnowledge([first.versionId]), false);
  assert.equal((await engine.lookupExact({ snapshot: answer.snapshot, policyHash: answer.policyHash, question: item.question }))?.versionId, second.versionId);
});

test('an outdated knowledge item requires explicit revalidation against the currently displayed revision', async t => {
  const { engine, answer, git } = await setup(t);
  const item = await engine.createCandidate(answer.id);
  const first = await engine.review(item.id, { expectedRevision: 1, action: 'publish', conditions: 'Initial', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'next');
  const current = await engine.snapshot(answer.snapshot.projectPath);
  await assert.rejects(engine.review(item.id, { expectedRevision: first.revision, action: 'revise', expectedSourceKey: current.key, conditions: 'Rechecked' }), (e: any) => e.status === 409);
  const next = await engine.review(item.id, { expectedRevision: first.revision, action: 'revise', revalidate: true, expectedSourceKey: current.key, conditions: 'Rechecked against current source' });
  assert.equal(next.snapshot.key, current.key);
  assert.equal(next.evidence[0].blobHash, first.evidence[0].blobHash);
});

test('beginReuse rejects a withdrawn exact knowledge version inside its transaction', async t => {
  const { engine, answer } = await setup(t);
  const candidate = await engine.createCandidate(answer.id);
  const published = await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'This commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
  await engine.review(candidate.id, { expectedRevision: 2, action: 'withdraw' });
  const record = { ...answer, id: 'reuse-withdrawn', requestId: 'reuse-withdrawn', source: 'exact' as const, knowledgeIds: [published.versionId] };
  await assert.rejects(engine.beginReuse({ requestId: record.requestId, historyId: record.historyId, question: record.question, originalLeaf: null, record }), (error: any) => error.status === 409);
  assert.deepEqual(await engine.pendingReuses(record.historyId), []);
});

test('outbox lease keeps cross-engine upsert and suspension delete ordered', async t => {
  const { engine, answer, root, mod, docs } = await setup(t);
  const candidate = await engine.createCandidate(answer.id);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  let syncs = 0;
  const index: KnowledgeIndex = {
    async sync(_project, changes) {
      syncs++;
      if (syncs === 1) { firstEntered(); await held; }
      for (const change of changes) change.op === 'delete' ? docs.delete(change.id) : docs.set(change.id, change.document);
    },
    async search() { return [...docs.keys()]; },
  };
  const first = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  const second = new mod.MemoryEngine({ dataDir: join(root, 'data'), index });
  try {
    const publishing = first.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: 'This commit', evidence: [{ path: 'logic.ts', startLine: 1, endLine: 1 }] });
    await entered;
    const published = await second.getKnowledge(candidate.id);
    await second.recordAnswer({ ...answer, id: 'race-exact', requestId: 'race-exact', source: 'exact', knowledgeIds: [published.versionId] });
    const suspending = second.feedback('race-exact', { clientId: 'client', vote: 'down', reason: 'incorrect' });
    for (let i = 0; i < 50 && await second.validKnowledge([published.versionId]); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(await second.validKnowledge([published.versionId]), false);
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseFirst();
    await Promise.all([publishing, suspending]);
    assert.equal(docs.has(published.versionId), false);
  } finally { releaseFirst(); await first.close(); await second.close(); }
});
