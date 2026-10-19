import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryError } from './errors.js';
import type { MemoryService } from './types.js';
export { MemoryError } from './errors.js';

/** No SQLite, native index or project I/O runs on the HTTP event loop. */
export function createMemoryService(options: { dataDir?: string } = {}): MemoryService {
  const dataDir = resolve(options.dataDir ?? process.env.CODE_ANALYZER_DATA_DIR ?? join(homedir(), '.code-analyzer'));
  let worker: Worker | undefined;
  let closed = false;
  let seq = 0;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); worker?.unref(); };
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { dataDir } });
    worker.on('message', ({ id, result, error }) => {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (error) waiter.reject(new MemoryError(error.message, error.status ?? 503));
      else waiter.resolve(result);
      if (!pending.size) worker?.unref();
    });
    worker.on('error', error => fail(new MemoryError(`Memory worker unavailable: ${error.message}`, 503)));
    worker.on('exit', code => { fail(new MemoryError(`Memory worker exited (${code})`, 503)); worker = undefined; });
    worker.unref(); return worker;
  };
  const call = (method: string, args: unknown[]): Promise<any> => {
    if (closed) return Promise.reject(new MemoryError('Memory service is closed', 503));
    return new Promise((resolveResult, reject) => {
      try {
        const active = start(); const id = ++seq;
        pending.set(id, { resolve: resolveResult, reject }); active.ref(); active.postMessage({ id, method, args });
      } catch (e) { reject(e instanceof MemoryError ? e : new MemoryError(String(e), 503)); }
    });
  };
  const service = Object.fromEntries(['snapshot', 'recordAnswer', 'getAnswer', 'findRequest', 'list', 'getKnowledge', 'createCandidate', 'feedback', 'getFeedback', 'previewEvidence', 'review', 'lookupExact', 'search', 'validKnowledge', 'beginReuse', 'finishReuse', 'pendingReuses', 'interruptReuse'].map(method => [method, (...args: unknown[]) => call(method, args)])) as unknown as MemoryService;
  service.close = () => {
    if (closePromise) return closePromise;
    if (!worker) { closed = true; return Promise.resolve(); }
    closePromise = call('close', []).then(() => undefined).finally(() => { closed = true; worker?.unref(); });
    closed = true;
    return closePromise;
  };
  return service;
}

let defaultService: MemoryService | undefined;
let defaultDataDir: string | undefined;
/** Older core runtimes retain ordinary analysis with memory disabled. */
export function getMemoryService(): MemoryService | undefined {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.env.CODE_ANALYZER_MEMORY === 'off' || major < 22 || (major === 22 && minor < 13)) return undefined;
  const dataDir = resolve(process.env.CODE_ANALYZER_DATA_DIR ?? join(homedir(), '.code-analyzer'));
  if (!defaultService || defaultDataDir !== dataDir) {
    const previous = defaultService;
    defaultService = createMemoryService({ dataDir }); defaultDataDir = dataDir;
    if (previous) void previous.close().catch(() => {});
  }
  return defaultService;
}
