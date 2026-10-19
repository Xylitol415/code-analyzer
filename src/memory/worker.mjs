import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { MemoryEngine } = await tsImport('./engine.ts', import.meta.url);
let index;
try {
  const { ZvecKnowledgeIndex } = await tsImport('./index.ts', import.meta.url);
  index = new ZvecKnowledgeIndex({ dataDir: workerData.dataDir });
} catch (error) {
  index = { async sync() { throw error; }, async search() { throw error; } };
}
const engine = new MemoryEngine({ dataDir: workerData.dataDir, index });
const methods = new Set(['snapshot', 'recordAnswer', 'getAnswer', 'findRequest', 'list', 'getKnowledge', 'createCandidate', 'feedback', 'getFeedback', 'previewEvidence', 'review', 'lookupExact', 'search', 'validKnowledge', 'beginReuse', 'finishReuse', 'pendingReuses', 'interruptReuse', 'close']);
let chain = Promise.resolve();
parentPort.on('message', message => {
  chain = chain.then(async () => {
    const { id, method, args } = message;
    try {
      if (!methods.has(method)) throw new Error('Invalid memory operation');
      const result = await engine[method](...args);
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), status: error?.status ?? 503 } });
    } finally { if (method === 'close') parentPort.close(); }
  });
});
