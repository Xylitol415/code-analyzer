import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { MemoryError } from './errors.js';
import { readSourceEvidence, snapshotSource } from './source.js';
import type { AnswerRecord, FeedbackInput, FeedbackResult, IndexChange, KnowledgeIndex, KnowledgeItem, LookupInput, MemoryLibrary, MemoryService, PendingReuse, ReviewInput } from './types.js';
export { MemoryError } from './errors.js';

const parse = <T>(row: any): T | undefined => row ? JSON.parse(row.json) : undefined;
const normalize = (q: string) => q.trim();

/** Authoritative durable state. Production constructs this exclusively in its worker. */
export class MemoryEngine implements MemoryService {
  private db: DatabaseSync;
  private index: KnowledgeIndex;
  private indexError?: string;
  private flushing?: Promise<void>;
  private flushLocks: string;
  constructor(options: { dataDir: string; index: KnowledgeIndex }) {
    mkdirSync(join(options.dataDir, 'memory'), { recursive: true, mode: 0o700 });
    this.flushLocks = join(options.dataDir, 'memory', 'flush-locks');
    this.db = new DatabaseSync(join(options.dataDir, 'memory', 'state.sqlite'));
    this.index = options.index;
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY, history TEXT NOT NULL, request TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(history,request));
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, version TEXT NOT NULL, sourceAnswer TEXT NOT NULL UNIQUE, project TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, knowledge TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(knowledge,revision));
      CREATE TABLE IF NOT EXISTS feedback(answer TEXT NOT NULL, client TEXT NOT NULL, vote TEXT, reason TEXT, json TEXT NOT NULL, PRIMARY KEY(answer,client));
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(history TEXT NOT NULL, request TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(history,request));`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async snapshot(project: string) { return snapshotSource(project); }
  private writeAnswer(record: AnswerRecord) {
    const previous = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE history=? AND request=?').get(record.historyId, record.requestId));
    const byId = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE id=?').get(record.id));
    if (previous || byId) {
      if (JSON.stringify(previous ?? byId) === JSON.stringify(record)) return;
      throw new MemoryError('Answer/request identity already exists', 409);
    }
    this.db.prepare('INSERT INTO answers VALUES(?,?,?,?)').run(record.id, record.historyId, record.requestId, JSON.stringify(record));
  }
  async recordAnswer(record: AnswerRecord) { this.transaction(() => this.writeAnswer(record)); }
  async getAnswer(id: string) { return parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE id=?').get(id)); }
  async findRequest(history: string, request: string) { return parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE history=? AND request=?').get(history, request)); }
  private current(id: string): KnowledgeItem {
    const row = this.db.prepare('SELECT json FROM knowledge WHERE id=? OR version=?').get(id, id) ?? this.db.prepare('SELECT k.json FROM versions v JOIN knowledge k ON k.id=v.knowledge WHERE v.id=?').get(id);
    const item = parse<KnowledgeItem>(row);
    if (!item) throw new MemoryError('Knowledge not found', 404);
    return item;
  }
  private counts(answerId: string) {
    const rows = this.db.prepare('SELECT vote,COUNT(*) AS count FROM feedback WHERE answer=? GROUP BY vote').all(answerId);
    return { up: Number(rows.find(r => r.vote === 'up')?.count ?? 0), down: Number(rows.find(r => r.vote === 'down')?.count ?? 0) };
  }
  private enqueue(item: KnowledgeItem, op: 'upsert' | 'delete') {
    const change = { id: item.versionId, op, ...(op === 'upsert' ? { document: { id: item.versionId, projectId: item.snapshot.projectId, sourceKey: item.snapshot.key, policyHash: item.policyHash, text: `${item.question}\n${item.answer}\n${item.conditions}` } } : {}) };
    this.db.prepare('INSERT INTO outbox(project,json) VALUES(?,?)').run(item.snapshot.projectId, JSON.stringify(change));
  }
  private save(item: KnowledgeItem, previous?: KnowledgeItem) {
    this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(item.versionId, item.id, item.revision, JSON.stringify(item));
    if (previous) {
      const result = this.db.prepare('UPDATE knowledge SET revision=?,version=?,json=? WHERE id=? AND revision=?').run(item.revision, item.versionId, JSON.stringify(item), item.id, previous.revision);
      if (result.changes !== 1) throw new MemoryError('Knowledge revision changed', 409);
      if (previous.state === 'published') this.enqueue(previous, 'delete');
    } else this.db.prepare('INSERT INTO knowledge VALUES(?,?,?,?,?,?)').run(item.id, item.revision, item.versionId, item.sourceAnswerId, item.snapshot.projectId, JSON.stringify(item));
    if (item.state === 'published') this.enqueue(item, 'upsert');
  }
  private candidate(answerId: string): KnowledgeItem {
    const previous = parse<KnowledgeItem>(this.db.prepare('SELECT json FROM knowledge WHERE sourceAnswer=?').get(answerId));
    if (previous) return { ...previous, ...this.counts(answerId) };
    const answer = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE id=?').get(answerId));
    if (!answer) throw new MemoryError('Answer not found', 404);
    if (answer.status !== 'completed' || !answer.answer.trim()) throw new MemoryError('Only completed answers can become candidates', 400);
    if (answer.source === 'exact' && answer.knowledgeIds.length) {
      try { return this.current(answer.knowledgeIds[0]); } catch { /* A removed origin can still be reviewed as a new candidate. */ }
    }
    const now = new Date().toISOString();
    const item: KnowledgeItem = { id: randomUUID(), versionId: randomUUID(), revision: 1, state: 'candidate', question: answer.question, answer: answer.answer, conditions: '', snapshot: answer.snapshot, policyHash: answer.policyHash, evidence: [], sourceAnswerId: answer.id, createdAt: now, updatedAt: now, ...this.counts(answerId) };
    this.save(item); return item;
  }
  async createCandidate(answerId: string) { return this.transaction(() => this.candidate(answerId)); }
  async getKnowledge(id: string) {
    const current = this.current(id);
    const versions = this.db.prepare('SELECT json FROM versions WHERE knowledge=? ORDER BY revision').all(current.id).map(r => parse<KnowledgeItem>(r)!);
    const rows = this.db.prepare(`SELECT f.answer,f.client,f.vote,f.reason,f.json FROM feedback f JOIN answers a ON a.id=f.answer
      WHERE f.answer=? OR EXISTS(SELECT 1 FROM json_each(a.json,'$.knowledgeIds') j JOIN versions v ON v.id=j.value WHERE v.knowledge=?) ORDER BY f.rowid DESC LIMIT 100`).all(current.sourceAnswerId, current.id);
    const clients = new Map<string, string>();
    for (const row of rows) if (!clients.has(String(row.client))) clients.set(String(row.client), String(row.vote));
    const feedback = rows.map(row => ({ answerId: String(row.answer), vote: row.vote as 'up' | 'down', ...(row.reason ? { reason: String(row.reason) as FeedbackInput['reason'] } : {}), ...(JSON.parse(String(row.json)).comment ? { comment: String(JSON.parse(String(row.json)).comment) } : {}) }));
    return { ...current, up: [...clients.values()].filter(v => v === 'up').length, down: [...clients.values()].filter(v => v === 'down').length, versions, feedback };
  }
  async getFeedback(answerId: string, clientId: string): Promise<FeedbackResult> {
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 200) throw new MemoryError('Invalid feedback client', 400);
    if (!await this.getAnswer(answerId)) throw new MemoryError('Answer not found', 404);
    const row = this.db.prepare('SELECT vote FROM feedback WHERE answer=? AND client=?').get(answerId, clientId);
    return { vote: (row?.vote ?? null) as FeedbackResult['vote'], ...this.counts(answerId) };
  }
  async previewEvidence(id: string, input: { expectedRevision: number; expectedSourceKey: string; evidence: import('./types.js').SourceEvidenceInput[] }) {
    const item = this.current(id);
    if (item.revision !== input.expectedRevision) throw new MemoryError('Knowledge revision changed', 409);
    const snapshot = snapshotSource(item.snapshot.projectPath);
    if (!snapshot.clean || snapshot.key !== input.expectedSourceKey) throw new MemoryError('Source changed; refresh before reviewing', 409);
    return { snapshot, evidence: readSourceEvidence(snapshot, input.evidence) };
  }
  async list(project: string, options: { state?: string; limit?: number; offset?: number } = {}): Promise<MemoryLibrary> {
    const snapshot = snapshotSource(project);
    await this.flush();
    let items = this.db.prepare('SELECT json FROM knowledge WHERE project=? ORDER BY rowid DESC').all(snapshot.projectId).map(r => parse<KnowledgeItem>(r)!).filter(i => !options.state || (options.state === 'needsreview' ? i.state === 'suspended' || (i.state === 'published' && (!snapshot.clean || snapshot.key !== i.snapshot.key)) : i.state === options.state));
    const total = items.length;
    items = items.slice(Math.max(0, options.offset ?? 0), Math.max(0, options.offset ?? 0) + Math.min(200, Math.max(1, options.limit ?? 50))).map(i => ({ ...i, ...this.counts(i.sourceAnswerId), applicable: snapshot.clean && snapshot.key === i.snapshot.key }));
    return { projectPath: snapshot.projectPath, snapshot, items, total, indexAvailable: !this.indexError, ...(this.indexError ? { indexError: this.indexError } : {}) };
  }
  async feedback(answerId: string, input: FeedbackInput): Promise<FeedbackResult> {
    if (!input.clientId?.trim() || input.clientId.length > 200 || ![null, 'up', 'down'].includes(input.vote) || (input.reason !== undefined && !['incorrect', 'outdated', 'irrelevant', 'presentation'].includes(input.reason))) throw new MemoryError('Invalid feedback', 400);
    const result = this.transaction(() => {
      const answer = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE id=?').get(answerId));
      if (!answer) throw new MemoryError('Answer not found', 404);
      if (answer.status !== 'completed') throw new MemoryError('Feedback requires a completed answer', 400);
      if (input.vote === null) this.db.prepare('DELETE FROM feedback WHERE answer=? AND client=?').run(answerId, input.clientId);
      else this.db.prepare('INSERT INTO feedback VALUES(?,?,?,?,?) ON CONFLICT(answer,client) DO UPDATE SET vote=excluded.vote,reason=excluded.reason,json=excluded.json').run(answerId, input.clientId, input.vote, input.reason ?? null, JSON.stringify(input));
      let knowledgeId: string | undefined;
      if (input.vote === 'up') knowledgeId = this.candidate(answerId).id;
      if (input.vote === 'down' && answer.source === 'exact' && ['incorrect', 'outdated'].includes(input.reason ?? '')) {
        for (const id of answer.knowledgeIds) {
          let item: KnowledgeItem; try { item = this.current(id); } catch { continue; }
          // Old feedback must never suspend a replacement revision.
          if (item.versionId === id && item.state === 'published') this.save({ ...item, versionId: randomUUID(), revision: item.revision + 1, state: 'suspended', updatedAt: new Date().toISOString() }, item);
        }
      }
      return { vote: input.vote, ...this.counts(answerId), ...(knowledgeId ? { knowledgeId } : {}) };
    });
    await this.flush(); return result;
  }
  async review(id: string, input: ReviewInput) {
    const item = this.transaction(() => {
      const old = this.current(id);
      if (!Number.isInteger(input.expectedRevision) || old.revision !== input.expectedRevision) throw new MemoryError('Knowledge revision changed', 409);
      if (!['publish', 'revise', 'suspend', 'withdraw'].includes(input.action)) throw new MemoryError('Invalid review action', 400);
      const next: KnowledgeItem = { ...old, versionId: randomUUID(), revision: old.revision + 1, question: input.question ?? old.question, answer: input.answer ?? old.answer, conditions: input.conditions ?? old.conditions, updatedAt: new Date().toISOString(), ...this.counts(old.sourceAnswerId) };
      if (!next.question.trim() || !next.answer.trim()) throw new MemoryError('Question and answer are required', 400);
      if (input.action === 'publish' || input.action === 'revise') {
        if (!next.conditions.trim()) throw new MemoryError('Nonempty conditions are required', 400);
        const current = snapshotSource(old.snapshot.projectPath);
        if (!current.clean || (input.expectedSourceKey !== undefined && input.expectedSourceKey !== current.key) ||
          ((current.key !== old.snapshot.key || !old.snapshot.clean) && (!input.revalidate || input.expectedSourceKey !== current.key))) throw new MemoryError('Source changed or is dirty; explicitly revalidate the currently displayed source revision', 409);
        next.snapshot = current;
        next.evidence = readSourceEvidence(current, input.evidence ?? old.evidence);
        const after = snapshotSource(old.snapshot.projectPath);
        if (!after.clean || after.key !== current.key) throw new MemoryError('Source changed while reading evidence', 409);
        next.state = 'published';
        const collisions = this.db.prepare('SELECT json FROM knowledge WHERE project=? AND id<>?').all(current.projectId, old.id).map(row => parse<KnowledgeItem>(row)!)
          .filter(item => item.state === 'published' && item.snapshot.key === current.key && item.policyHash === next.policyHash && normalize(item.question) === normalize(next.question));
        for (const previous of collisions) this.save({ ...previous, state: 'superseded', versionId: randomUUID(), revision: previous.revision + 1, updatedAt: next.updatedAt }, previous);
      } else next.state = input.action === 'suspend' ? 'suspended' : 'withdrawn';
      this.save(next, old); return next;
    });
    await this.flush(); return item;
  }
  private applicable(item: KnowledgeItem, input: LookupInput) { return item.state === 'published' && item.snapshot.clean && input.snapshot.clean && item.snapshot.projectId === input.snapshot.projectId && item.snapshot.key === input.snapshot.key && item.policyHash === input.policyHash; }
  async lookupExact(input: LookupInput) {
    if (!input.snapshot.clean) return undefined;
    const rows = this.db.prepare('SELECT json FROM knowledge WHERE project=? ORDER BY rowid DESC').all(input.snapshot.projectId);
    return rows.map(r => parse<KnowledgeItem>(r)!).find(item => this.applicable(item, input) && normalize(item.question) === normalize(input.question));
  }
  async search(input: LookupInput) {
    if (!input.snapshot.clean) return [];
    if (this.index.rebuild && this.index.needsRebuild && await this.index.needsRebuild(input.snapshot.projectId)) {
      const documents = this.db.prepare('SELECT json FROM knowledge WHERE project=?').all(input.snapshot.projectId)
        .map(row => parse<KnowledgeItem>(row)!).filter(item => item.state === 'published')
        .map(item => ({ id: item.versionId, projectId: item.snapshot.projectId, sourceKey: item.snapshot.key, policyHash: item.policyHash, text: `${item.question}\n${item.answer}\n${item.conditions}` }));
      if (documents.length) try { await this.index.rebuild(input.snapshot.projectId, documents); } catch (e) { this.indexError = e instanceof Error ? e.message : String(e); }
    }
    await this.flush();
    let ids: string[];
    try { ids = await this.index.search({ projectId: input.snapshot.projectId, sourceKey: input.snapshot.key, policyHash: input.policyHash, question: input.question, limit: Math.min(20, Math.max(1, input.limit ?? 5)) }); this.indexError = undefined; }
    catch (e) { this.indexError = e instanceof Error ? e.message : String(e); return []; }
    const result: KnowledgeItem[] = [];
    for (const id of new Set(ids)) {
      const item = parse<KnowledgeItem>(this.db.prepare('SELECT json FROM knowledge WHERE version=?').get(id));
      if (item && this.applicable(item, input)) result.push(item);
    }
    return result.slice(0, Math.min(20, Math.max(1, input.limit ?? 5)));
  }
  async validKnowledge(ids: string[]) { return ids.every(id => parse<KnowledgeItem>(this.db.prepare('SELECT json FROM knowledge WHERE version=?').get(id))?.state === 'published'); }
  async beginReuse(pending: PendingReuse) {
    this.transaction(() => {
      if (pending.question !== pending.record.question || pending.requestId !== pending.record.requestId || pending.historyId !== pending.record.historyId) throw new MemoryError('Reuse identity mismatch', 409);
      if (pending.record.source === 'exact') {
        if (pending.record.knowledgeIds.length !== 1 || pending.record.knowledgeIds.some(id => {
          const item = parse<KnowledgeItem>(this.db.prepare('SELECT json FROM knowledge WHERE version=?').get(id));
          return !item || !this.applicable(item, { snapshot: pending.record.snapshot, policyHash: pending.record.policyHash, question: pending.question });
        })) throw new MemoryError('Reviewed knowledge is no longer available', 409);
      }
      const existing = parse<PendingReuse>(this.db.prepare('SELECT json FROM pending WHERE history=? AND request=?').get(pending.historyId, pending.requestId));
      const completed = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE history=? AND request=?').get(pending.historyId, pending.requestId));
      if ((existing && JSON.stringify(existing) !== JSON.stringify(pending)) || (completed && (completed.question !== pending.question || completed.id !== pending.record.id))) throw new MemoryError('Request already belongs to another operation', 409);
      if (!existing && !completed) this.db.prepare('INSERT INTO pending VALUES(?,?,?)').run(pending.historyId, pending.requestId, JSON.stringify(pending));
    });
  }
  private completeReuse(request: string, history: string, interrupted: boolean) {
    this.transaction(() => {
      const pending = parse<PendingReuse>(this.db.prepare('SELECT json FROM pending WHERE history=? AND request=?').get(history, request));
      if (!pending) return;
      const existing = parse<AnswerRecord>(this.db.prepare('SELECT json FROM answers WHERE history=? AND request=?').get(history, request));
      if (existing && (existing.id !== pending.record.id || existing.question !== pending.question)) throw new MemoryError('Reuse completion identity conflict', 409);
      if (!existing) this.writeAnswer({ ...pending.record, ...(interrupted ? { status: 'interrupted' as const } : {}) });
      this.db.prepare('DELETE FROM pending WHERE history=? AND request=?').run(history, request);
    });
  }
  async finishReuse(request: string, history: string) { this.completeReuse(request, history, false); }
  async interruptReuse(request: string, history: string) { this.completeReuse(request, history, true); }
  async pendingReuses(history: string) { return this.db.prepare('SELECT json FROM pending WHERE history=? ORDER BY rowid').all(history).map(row => parse<PendingReuse>(row)!); }
  private async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const projects = this.db.prepare('SELECT DISTINCT project FROM outbox').all();
      for (const row of projects) {
        const project = String(row.project);
        try {
          mkdirSync(this.flushLocks, { recursive: true, mode: 0o700 });
          const guard = join(this.flushLocks, createHash('sha256').update(project).digest('hex'));
          mkdirSync(guard, { recursive: true, mode: 0o700 });
          const release = await lockfile.lock(guard, { realpath: true, stale: 30_000, update: 10_000, retries: { retries: 60, minTimeout: 20, maxTimeout: 100, factor: 1.3 } });
          try {
            const rows = this.db.prepare('SELECT seq,json FROM outbox WHERE project=? ORDER BY seq').all(project);
            const changes = rows.map(r => ({ ...JSON.parse(String(r.json)), seq: Number(r.seq) } as IndexChange));
            if (changes.length) {
              await this.index.sync(project, changes);
              this.db.prepare('DELETE FROM outbox WHERE project=? AND seq<=?').run(project, changes.at(-1)!.seq);
            }
            this.indexError = undefined;
          } finally { await release(); }
        }
        catch (e) { this.indexError = e instanceof Error ? e.message : String(e); }
      }
    })();
    try { await this.flushing; } finally { this.flushing = undefined; }
  }
  async close() { if (this.flushing) await this.flushing; await this.index.close?.(); this.db.close(); }
}
