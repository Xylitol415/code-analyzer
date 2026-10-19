import { access, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { IndexChange, KnowledgeIndex, KnowledgeIndexDocument } from "./types.js";
import type { ZVecCollection } from "@zvec/zvec";

let native: Promise<typeof import("@zvec/zvec")> | undefined;
function loadNative() {
  native ??= import("@zvec/zvec").then((module) => {
    module.ZVecInitialize({ logLevel: module.ZVecLogLevel.ERROR, queryThreads: 2, optimizeThreads: 1 });
    return module;
  });
  return native;
}

function safeKey(value: string, label: string): string {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Called exclusively by the memory worker. No collection handle survives an operation. */
export class ZvecKnowledgeIndex implements KnowledgeIndex {
  private readonly root: string;
  private readonly broken = new Set<string>();
  constructor(options: { dataDir: string }) {
    this.root = resolve(options.dataDir, "memory", "index");
  }

  private async operation<T>(projectId: string, write: boolean, action: (collection: ZVecCollection) => Promise<T>, rebuild = false): Promise<T | undefined> {
    safeKey(projectId, "project ID");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const guard = join(this.root, `${projectId}.guard`);
    await mkdir(guard, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(guard, {
      realpath: true, stale: 30_000, update: 10_000,
      // A cold process also loads the tokenizer while holding this lock.
      // Keep writes retryable across its startup; retrieval has its own soft deadline.
      retries: { retries: 60, minTimeout: 20, maxTimeout: 100, factor: 1.3 },
    });
    let collection: ZVecCollection | undefined;
    let backup: string | undefined;
    try {
      const path = join(this.root, projectId);
      let exists = await access(path).then(() => true, () => false);
      if (!exists && !write) return undefined;
      const z = await loadNative();
      if (exists) {
        try { collection = z.ZVecOpen(path, { readOnly: !write }); }
        catch (error) {
          if (!rebuild) throw error;
          backup = `${path}.previous-${randomUUID()}`; await rename(path, backup); exists = false;
        }
      }
      collection ??= z.ZVecCreateAndOpen(path, new z.ZVecCollectionSchema({
        name: "project_knowledge",
        fields: [
          { name: "source_key", dataType: z.ZVecDataType.STRING, indexParams: { indexType: z.ZVecIndexType.INVERT } },
          { name: "policy_hash", dataType: z.ZVecDataType.STRING, indexParams: { indexType: z.ZVecIndexType.INVERT } },
          { name: "search_text", dataType: z.ZVecDataType.STRING, indexParams: { indexType: z.ZVecIndexType.FTS, tokenizerName: "jieba" } },
        ],
      }));
      return await action(collection);
    } catch (error) {
      this.broken.add(projectId);
      throw error;
    } finally {
      try { collection?.closeSync(); }
      finally { try { if (backup) await rm(backup, { recursive: true, force: true }); } finally { await release(); } }
    }
  }

  async needsRebuild(projectId: string): Promise<boolean> {
    safeKey(projectId, "project ID");
    return this.broken.has(projectId) || !await access(join(this.root, projectId)).then(() => true, () => false);
  }

  async rebuild(projectId: string, documents: KnowledgeIndexDocument[]): Promise<void> {
    await this.operation(projectId, true, async collection => {
      // zvec 0.7.1 limits each write batch to 1024 documents.
      for (let offset = 0; offset < documents.length; offset += 1024) {
        const statuses = collection.upsertSync(documents.slice(offset, offset + 1024).map(doc => {
          if (doc.projectId !== projectId) throw new Error("Index document project mismatch");
          return { id: safeKey(doc.id, "document ID"), fields: {
            source_key: safeKey(doc.sourceKey, "source key"), policy_hash: safeKey(doc.policyHash, "policy hash"), search_text: doc.text,
          } };
        }));
        if (statuses.some(status => !status.ok)) throw new Error("知识索引重建失败");
      }
    }, true);
    this.broken.delete(projectId);
  }

  async sync(projectId: string, changes: IndexChange[]): Promise<void> {
    if (!changes.length) return;
    await this.operation(projectId, true, async (collection) => {
      for (const change of changes) {
        safeKey(change.id, "document ID");
        if (change.op === "delete") {
          const result = collection.deleteSync(change.id);
          if (!result.ok && !/NOT_FOUND|not found/i.test(`${result.code} ${result.message}`)) throw new Error(result.message);
        } else {
          const doc = change.document;
          if (!doc || doc.projectId !== projectId || doc.id !== change.id) throw new Error("Index document project mismatch");
          const result = collection.upsertSync({
            id: doc.id,
            fields: { source_key: safeKey(doc.sourceKey, "source key"), policy_hash: safeKey(doc.policyHash, "policy hash"), search_text: doc.text },
          });
          if (!result.ok) throw new Error(result.message);
        }
      }
    });
  }

  async search(input: { projectId: string; sourceKey: string; policyHash: string; question: string; limit: number }): Promise<string[]> {
    safeKey(input.projectId, "project ID");
    const source = safeKey(input.sourceKey, "source key");
    const policy = safeKey(input.policyHash, "policy hash");
    if (!input.question.trim()) return [];
    return await this.operation(input.projectId, false, async (collection) => {
      const docs = await collection.query({
        fieldName: "search_text", fts: { matchString: input.question },
        filter: `source_key = '${source}' AND policy_hash = '${policy}'`,
        topk: Math.max(1, Math.min(20, Math.floor(input.limit))), outputFields: [],
      });
      return docs.map((doc) => doc.id);
    }) ?? [];
  }

  async close(): Promise<void> { /* Every operation already closes its native handle. */ }
}
