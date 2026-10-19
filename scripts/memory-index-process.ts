// Process boundary for the reproducible native probe. Never reads application data.
import { ZvecKnowledgeIndex } from '../src/memory/index.js';
import { performance } from 'node:perf_hooks';
const [dataDir, action, sizeText = '0', suffix = 'a'] = process.argv.slice(2);
const size = Number(sizeText);
const index = new ZvecKnowledgeIndex({ dataDir });
const projectId = 'benchmark-project';
const doc = (id: string, i: number) => ({ id, projectId, sourceKey: 'commit-a', policyHash: 'policy-a',
  text: `会话中止 cancellation_${i}：停止按钮通过后端取消模型请求，保留已生成的回复。适用条件：仅当前静态代码版本；外部服务的计费和实时运行状态需要另行确认。${'参考源码说明，独立请求与历史会话各自隔离。'.repeat(8)}` });
const started = performance.now();
if (action === 'seed') await index.rebuild(projectId, Array.from({ length: size }, (_, i) => doc(`entry-${i}`, i)));
else if (action === 'write') await index.sync(projectId, Array.from({ length: size }, (_, i) => ({ seq: i, id: `${suffix}-${i}`, op: 'upsert' as const, document: doc(`${suffix}-${i}`, i) })));
else if (action === 'read') {
  const times: number[] = [];
  for (let i = 0; i < size; i++) {
    const start = performance.now();
    const ids = await index.search({ projectId, sourceKey: 'commit-a', policyHash: 'policy-a', question: '会话中止', limit: 5 });
    if (ids.length !== 5) throw new Error(`Expected 5 hits, received ${ids.length}`);
    times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ elapsedMs: performance.now() - started, times }));
} else if (action === 'verify-writers') {
  // Only writers use this source/policy in the dedicated temporary collection.
  const ids = await index.search({ projectId, sourceKey: 'commit-a', policyHash: 'policy-a', question: 'cancellation_0', limit: 20 });
  if (!['a-0', 'b-0'].every(id => ids.includes(id))) throw new Error(`Concurrent writes lost: ${ids}`);
}
if (action !== 'read') console.log(JSON.stringify({ elapsedMs: performance.now() - started }));
await index.close();
