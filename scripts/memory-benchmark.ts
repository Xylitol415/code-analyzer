import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'memory-benchmark-'));
const child = fileURLToPath(new URL('./memory-index-process.ts', import.meta.url));
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const run = async (data: string, action: string, n: number, suffix?: string) => {
  const start = performance.now();
  const result = await exec(process.execPath, ['--import', 'tsx', child, data, action, String(n), ...(suffix ? [suffix] : [])], { maxBuffer: 1024 * 1024 });
  return { ...JSON.parse(result.stdout.trim()), processMs: performance.now() - start };
};
try {
  const collections = [];
  for (const count of [1000, 10000]) {
    const data = join(root, String(count));
    const seed = await run(data, 'seed', count);
    const trials = [];
    let ticks = 0;
    let last = performance.now();
    let maxLag = 0;
    const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now; ticks++; }, 5);
    try { for (let trial = 0; trial < 5; trial++) trials.push(await run(data, 'read', 21)); }
    finally { clearInterval(timer); }
    const hot = trials.flatMap(trial => trial.times.slice(1));
    collections.push({ count, seedMs: seed.elapsedMs,
      coldFirstQueryMs: { p50: quantile(trials.map(t => t.times[0]), .5), p95: quantile(trials.map(t => t.times[0]), .95), samples: 5 },
      coldProcessMs: { p50: quantile(trials.map(t => t.processMs), .5), p95: quantile(trials.map(t => t.processMs), .95) },
      warmOpenQueryCloseMs: { p50: quantile(hot, .5), p95: quantile(hot, .95), samples: hot.length },
      parentEventLoop: { ticks, maxLagMs: Math.max(0, maxLag) } });
    assert.ok(ticks > 0);
  }
  const concurrentData = join(root, 'concurrent');
  await Promise.all([run(concurrentData, 'write', 5, 'a'), run(concurrentData, 'write', 5, 'b')]);
  await run(concurrentData, 'verify-writers', 0);
  console.log(JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    nativeVersion: '0.7.1', scope: 'synthetic BM25; 5 cold processes × 21 queries; no model/embedding; parent timer measures process isolation',
    crossProcessWrites: 'passed', collections }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
