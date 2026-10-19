/** Deterministic retrieval-boundary fixture, not a benchmark of model/business accuracy. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/memory/engine.js';
import { ZvecKnowledgeIndex } from '../src/memory/index.js';
import type { AnswerRecord, SourceSnapshot } from '../src/memory/types.js';

const families: { id: string; split: string; symbol: string; topic: string }[] = JSON.parse(await readFile(new URL('../tests/fixtures/memory-families.json', import.meta.url), 'utf8'));
assert.equal(families.length, 20);
const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-evaluation-')));
const dataDir = join(root, 'data');
const index = new ZvecKnowledgeIndex({ dataDir });
const engine = new MemoryEngine({ dataDir, index });
const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const source = families.map(f => `export const ${f.symbol} = true; // ${f.topic}`).join('\n') + '\n';
const createRepo = async (name: string) => {
  const path = join(root, name); execFileSync('git', ['init', '-q', path]);
  await writeFile(join(path, 'fixture.ts'), source); git(path, 'add', '.');
  git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return path;
};
const results: { family: string; split: string; scenario: string; passed: boolean }[] = [];
try {
  const repo = await createRepo('project-a');
  const other = await createRepo('project-b');
  const snapshot = await engine.snapshot(repo);
  const otherSnapshot = await engine.snapshot(other);
  const items = [];
  for (const [i, f] of families.entries()) {
    const answer: AnswerRecord = { id: f.id, version: 'v1', requestId: f.id, historyId: f.id,
      question: `${f.topic} ${f.symbol} 的配置是什么？`, answer: `固定测试提交中 ${f.symbol} 为 true，见 fixture.ts:${i + 1}。`,
      status: 'completed', source: 'generated', snapshot, policyHash: 'fixture-policy', knowledgeIds: [], assistantEntryIds: [],
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null, quality: 'unknown' }, elapsedMs: 0, createdAt: new Date().toISOString() };
    await engine.recordAnswer(answer);
    const candidate = await engine.createCandidate(answer.id);
    items.push(await engine.review(candidate.id, { expectedRevision: 1, action: 'publish', conditions: '仅固定测试提交中的静态布尔配置，不说明运行状态、外部计费或数据库内容。', evidence: [{ path: 'fixture.ts', startLine: i + 1, endLine: i + 1 }] }));
  }
  const check = (i: number, scenario: string, passed: boolean) => results.push({ family: families[i].id, split: families[i].split, scenario, passed });
  const lookup = (question: string, sourceSnapshot: SourceSnapshot = snapshot, policyHash = 'fixture-policy') => engine.lookupExact({ snapshot: sourceSnapshot, policyHash, question });
  for (const [i, f] of families.entries()) {
    const item = items[i];
    check(i, 'exact-same-source', (await lookup(item.question))?.versionId === item.versionId);
    const hits = await engine.search({ snapshot, policyHash: 'fixture-policy', question: `${f.symbol} ${f.topic} 是如何配置的？`, limit: 5 });
    check(i, 'paraphrase-evidence', hits.some(hit => hit.versionId === item.versionId && hit.conditions.includes('不说明运行状态')));
    check(i, 'outside-conditions-no-direct-answer', !await lookup(`${f.symbol} 当前外部服务计费是否停止？`));
    check(i, 'other-project', !await lookup(item.question, otherSnapshot));
    check(i, 'other-policy', !await lookup(item.question, snapshot, 'other-policy'));
  }
  await writeFile(join(repo, 'fixture.ts'), source + '// dirty\n');
  const dirty = await engine.snapshot(repo);
  for (const [i, item] of items.entries()) check(i, 'dirty-tree', !await lookup(item.question, dirty));
  await writeFile(join(repo, 'fixture.ts'), source);
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next-revision');
  const changed = await engine.snapshot(repo);
  for (const [i, item] of items.entries()) check(i, 'changed-revision', !await lookup(item.question, changed));
  for (const [i, item] of items.entries()) {
    await engine.review(item.id, { expectedRevision: item.revision, action: 'withdraw' });
    check(i, 'withdrawn', !await lookup(item.question));
  }
  const report = { at: new Date().toISOString(), scope: '20 synthetic code families × 8 boundaries; lexical paraphrases share symbols; no real model or business labels',
    scenarios: [...new Set(results.map(r => r.scenario))], families: 20, total: results.length, passed: results.filter(r => r.passed).length,
    splits: Object.fromEntries(['dev', 'acceptance'].map(split => [split, { total: results.filter(r => r.split === split).length, passed: results.filter(r => r.split === split && r.passed).length }])), failures: results.filter(r => !r.passed) };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.total, 160); assert.equal(report.passed, report.total);
} finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
