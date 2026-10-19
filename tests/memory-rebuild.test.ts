import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryService } from '../src/memory/service.js';

test('worker recovers a deleted or corrupt native index from authoritative published SQLite data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-reseed-'));
  const repo = join(root, 'project');
  const dataDir = join(root, 'data');
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'feature.ts'), 'export const enabled = true;\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: repo });
  let service = createMemoryService({ dataDir });
  try {
    const snapshot = await service.snapshot(repo);
    await service.recordAnswer({ id: 'answer', version: 'one', historyId: 'history', requestId: 'request', question: '功能默认启用吗？', answer: '默认启用。', status: 'completed', source: 'generated', snapshot, policyHash: 'policy', knowledgeIds: [], assistantEntryIds: [], usage: { input: null, output: null, cacheRead: null, cacheWrite: null, quality: 'unknown' }, elapsedMs: 0, createdAt: new Date().toISOString() });
    const candidate = await service.createCandidate('answer');
    const item = await service.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: '固定代码版本', evidence: [{ path: 'feature.ts', startLine: 1, endLine: 1 }] });
    await service.close();
    const indexPath = join(dataDir, 'memory', 'index', snapshot.projectId);
    await rm(indexPath, { recursive: true, force: true });
    service = createMemoryService({ dataDir });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try { assert.equal((await service.search({ snapshot, policyHash: 'policy', question: '默认启用', limit: 5 }))[0]?.versionId, item.versionId); }
    finally { clearInterval(timer); }
    assert.ok(ticks > 0, 'native loading/reseed runs outside HTTP event loop');
    await service.close();
    await rm(indexPath, { recursive: true, force: true });
    await mkdir(indexPath); await writeFile(join(indexPath, 'broken'), 'not a collection');
    service = createMemoryService({ dataDir });
    assert.deepEqual(await service.search({ snapshot, policyHash: 'policy', question: '默认启用', limit: 5 }), []);
    assert.equal((await service.search({ snapshot, policyHash: 'policy', question: '默认启用', limit: 5 }))[0]?.versionId, item.versionId);
    assert.equal((await service.lookupExact({ snapshot, policyHash: 'policy', question: item.question }))?.versionId, item.versionId);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
