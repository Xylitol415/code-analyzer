import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('worker facade snapshots Git without blocking main event loop and closes cleanly', async t => {
  const mod = await import('../src/memory/service.js').catch(() => undefined);
  assert.equal(typeof mod?.createMemoryService, 'function', 'worker facade must be available');
  const root = mkdtempSync(join(tmpdir(), 'memory-worker-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'file.ts'), 'const n = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@example.test', 'commit', '-qm', 'initial'], { cwd: repo });
  const service = mod!.createMemoryService({ dataDir: join(root, 'data') });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const snapshot = await service.snapshot(repo);
  clearInterval(timer);
  assert.equal(snapshot.clean, true);
  assert.ok(ticks > 0, 'main event loop must progress while native worker starts');
  await assert.rejects(service.getKnowledge('missing'), (e: any) => e instanceof mod!.MemoryError && e.status === 404);
  await service.close();
  await assert.rejects(service.snapshot(repo), (e: any) => e.status === 503);
});
