import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runAsk } from "../src/ask.ts";
import { historyMessages } from "../src/session-history.ts";
import * as runtime from "../src/memory/runtime.ts";
import { MemoryError } from "../src/memory/errors.ts";

const snapshot = { projectPath: "/project", projectId: "p", branch: "main", commit: "a", key: "a", clean: true };
const knowledge = { id: "k", versionId: "kv", revision: 1, state: "published", question: "where", answer: "Reviewed answer", conditions: "static only", snapshot, policyHash: "any", evidence: [], sourceAnswerId: "old", createdAt: "now", updatedAt: "now", up: 1, down: 0 };
function fixture() {
  const manager = SessionManager.inMemory("/project");
  let listener;
  let calls = 0;
  let current = snapshot;
  let valid = true;
  let exact = knowledge;
  const records = new Map();
  const pending = new Map();
  const agent = { transformContext: async (messages) => messages.map((x) => ({ ...x, original: true })) };
  const session = {
    sessionManager: manager, agent,
    systemPrompt: "system", model: { provider: "test", id: "model", api: "openai-completions", baseUrl: "https://example.com/v1" },
    refreshContext() { this.messages = manager.buildSessionContext().messages; }, messages: [],
    subscribe(cb) { listener = cb; return () => {}; },
    getSessionStats: () => ({ tokens: { input: calls * 10, output: calls * 4, cacheRead: 0, cacheWrite: 0 } }),
    async prompt(question, options) {
      options?.preflightResult?.(); calls++;
      manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
      const message = { role: "assistant", content: [{ type: "text", text: "Final answer" }], api: "openai-completions", provider: "test", model: "model", stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Tool preamble" } });
      listener({ type: "message_end", message });
      manager.appendMessage(message); this.refreshContext();
    },
  };
  const service = {
    snapshot: async () => current, validKnowledge: async () => valid,
    lookupExact: async () => exact, search: async () => [knowledge],
    recordAnswer: async (record) => { records.set(record.requestId, record); },
    findRequest: async (_history, id) => records.get(id),
    beginReuse: async (operation) => { pending.set(operation.requestId, operation); },
    finishReuse: async (id) => { const operation = pending.get(id); records.set(id, operation.record); pending.delete(id); },
    pendingReuses: async () => [...pending.values()], interruptReuse: async (id) => { pending.delete(id); },
  };
  return { session, service, records, pending, manager, calls: () => calls, setSnapshot: (x) => current = x, setValid: (x) => valid = x, setExact: (x) => exact = x };
}

test("applied steering binds knowledge candidates to the corrected question and preserves retry identity", async () => {
  const f = fixture(); f.setExact(undefined);
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const originalPrompt = f.session.prompt;
  let projected;
  f.session.prompt = async function (question, options) {
    runtime.applyMemorySteering(this, { requestId: "correction", question: "Only describe the read path", targetRequestId: "original" });
    projected = await this.agent.transformContext([{ role: "user", content: "correction", timestamp: 1 }]);
    return originalPrompt.call(this, question, options);
  };
  const outcome = await runAsk(f.session, "Describe all writes", undefined, undefined, { requestId: "original" });
  const record = f.records.get("original");
  assert.equal(record.originalQuestion, "Describe all writes");
  assert.match(record.question, /Describe all writes/);
  assert.match(record.question, /Only describe the read path/);
  assert.deepEqual(record.steering, [{ requestId: "correction", question: "Only describe the read path" }]);
  assert.doesNotMatch(JSON.stringify(projected), /Reviewed answer/);
  assert.equal((await runAsk(f.session, "Describe all writes", undefined, undefined, { requestId: "original" })).metadata.answerId, outcome.metadata.answerId);
  assert.equal(f.calls(), 1);
});

test("first reviewed hit appends actual conversation, survives refresh, and retry never duplicates history", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const events = [];
  const result = await runAsk(f.session, "where", (event) => events.push(event), undefined, { requestId: "r1" });
  assert.equal(result.answer, "Reviewed answer");
  assert.equal(f.calls(), 0);
  assert.equal(result.metadata.usage.quality, "no-model-call");
  assert.deepEqual(f.session.messages.filter((x) => x.role === "user" || x.role === "assistant").map((x) => x.role), ["user", "assistant"]);
  assert.equal(events.filter((x) => x.type === "answer_reused").length, 1);
  const before = f.manager.getEntries().length;
  const retry = await runAsk(f.session, "where", undefined, undefined, { requestId: "r1" });
  assert.equal(retry.metadata.answerId, result.metadata.answerId);
  assert.equal(f.manager.getEntries().length, before);
  const history = historyMessages(f.manager.getBranch());
  assert.equal(history[1].answerId, result.metadata.answerId);
  assert.equal(history[1].content, result.answer);
  await assert.rejects(runAsk(f.session, "different", undefined, undefined, { requestId: "r1" }), { status: 409 });
});

test("later turns preserve original context transformer and use transient evidence then reject changed source", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  let projected;
  const originalPrompt = f.session.prompt;
  f.session.prompt = async function (question, options) {
    projected = await this.agent.transformContext([{ role: "system", content: "system", timestamp: 1 }]);
    return originalPrompt.call(this, question, options);
  };
  await runAsk(f.session, "follow up");
  assert.ok(projected[0].original);
  assert.match(JSON.stringify(projected), /Reviewed answer/);
  assert.doesNotMatch(JSON.stringify(await f.session.agent.transformContext([{ role: "system", content: "system", timestamp: 1 }])), /Reviewed answer/);
  f.setSnapshot({ ...snapshot, key: "b", commit: "b" });
  await assert.rejects(runAsk(f.session, "again"), { code: "context_stale" });
});

test("generated completion uses settled canonical message and reported usage delta", async () => {
  const f = fixture(); f.setExact(undefined);
  f.service.search = async () => [];
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const result = await runAsk(f.session, "question", undefined, undefined, { requestId: "r2" });
  assert.equal(result.answer, "Final answer");
  assert.equal(result.metadata.source, "generated");
  assert.deepEqual(result.metadata.usage, { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, quality: "reported" });
  f.service.search = async () => [knowledge];
  await runAsk(f.session, "second");
  f.setValid(false);
  await assert.rejects(runAsk(f.session, "third"), { code: "context_stale" });
});

test("first nonexact question uses evidence as user data while preserving system instructions", async () => {
  const f = fixture(); f.setExact(undefined);
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const original = f.session.prompt;
  let projected;
  f.session.prompt = async function (question, options) {
    projected = await this.agent.transformContext([{ role: "system", content: "host instruction", timestamp: 1 }, { role: "user", content: question, timestamp: 2 }]);
    return original.call(this, question, options);
  };
  const answer = await runAsk(f.session, "a similar but different question");
  assert.equal(answer.metadata.source, "assisted");
  assert.equal(projected[0].content, "host instruction");
  assert.equal(projected.at(-1).content, "a similar but different question");
  assert.ok(projected.some(message => message.role === "user" && JSON.stringify(message.content).includes("Reviewed answer")));
});

test("ordinary analysis in an unchanged dirty checkout remains usable without knowledge reuse", async () => {
  const f = fixture(); f.setExact(undefined); f.setSnapshot({ ...snapshot, clean: false });
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "first");
  assert.equal((await runAsk(f.session, "second")).answer, "Final answer");
  assert.equal(f.calls(), 2);
});

test("replay keeps a durable new SDK session and restored follow-up sees the reused answer", async (t) => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createReadOnlySession } = await import("../src/session-factory.ts");
  const directory = await mkdtemp(join(tmpdir(), "memory-sdk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memorySetting = process.env.CODE_ANALYZER_MEMORY;
  process.env.CODE_ANALYZER_MEMORY = "off";
  const { session } = await createReadOnlySession(directory, { resume: false, llm: { baseUrl: "https://never.invalid/v1", model: "test" } });
  if (memorySetting === undefined) delete process.env.CODE_ANALYZER_MEMORY;
  else process.env.CODE_ANALYZER_MEMORY = memorySetting;
  t.after(() => session.dispose());
  const f = fixture();
  runtime.attachSessionMemory(session, { projectPath: directory, service: f.service });
  const result = await runAsk(session, "where", undefined, undefined, { requestId: "sdk-replay" });
  assert.equal(result.answer, "Reviewed answer");
  const transcript = await readFile(session.sessionManager.getSessionFile(), "utf8");
  assert.match(transcript, /answer_completed/);
  const reopened = SessionManager.open(session.sessionManager.getSessionFile());
  assert.deepEqual(historyMessages(reopened.getBranch()).map((message) => message.content), ["where", "Reviewed answer"]);
  assert.ok(JSON.stringify(session.messages).includes("Reviewed answer"));
});

test("failed journal finalization returns the durable replay and recovers without another model call", async () => {
  const f = fixture();
  const finish = f.service.finishReuse;
  let fail = true;
  f.service.finishReuse = async (...args) => { if (fail) throw new Error("disk busy"); return finish(...args); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const first = await runAsk(f.session, "where", undefined, undefined, { requestId: "recover" });
  assert.equal(first.answer, "Reviewed answer");
  assert.equal(f.calls(), 0);
  assert.equal(f.pending.size, 1);
  const length = f.manager.getEntries().length;
  fail = false;
  const retried = await runAsk(f.session, "where", undefined, undefined, { requestId: "recover" });
  assert.equal(retried.metadata.answerId, first.metadata.answerId);
  assert.equal(f.pending.size, 0);
  assert.equal(f.manager.getEntries().length, length);
});

test("partial replay blocks continuation rather than appending a conflicting answer", async () => {
  const f = fixture();
  const append = f.manager.appendMessage.bind(f.manager);
  f.manager.appendMessage = (message) => { if (message.role === "assistant") throw new Error("disk full"); return append(message); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where", undefined, undefined, { requestId: "partial" }), { code: "request_conflict" });
  assert.equal(f.calls(), 0);
  f.manager.appendMessage = append;
  await assert.rejects(runAsk(f.session, "where", undefined, undefined, { requestId: "partial" }), { code: "request_conflict" });
  assert.equal(f.calls(), 0);
});

test("restored used knowledge and changed source block bypass before any model call", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  // A new binding has no in-memory state; durable completion drives invalidation.
  const restored = { ...f.session, agent: { transformContext: async (messages) => messages } };
  runtime.attachSessionMemory(restored, { projectPath: "/project", service: f.service });
  f.setValid(false);
  await assert.rejects(runAsk(restored, "again", undefined, undefined, { reuse: "bypass" }), { reason: "knowledge_revoked" });
  f.setSnapshot({ ...snapshot, clean: false });
  await assert.rejects(runAsk(restored, "again", undefined, undefined, { reuse: "bypass" }), { reason: "source_changed" });
  assert.equal(f.calls(), 0);
});

test("evidence uses immutable revision IDs and excludes whole entries above the token budget", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  f.service.search = async () => [{ ...knowledge, id: "huge", versionId: "huge-v", answer: "文".repeat(4000) }, knowledge];
  const result = await runAsk(f.session, "second");
  assert.deepEqual(result.metadata.knowledgeIds, ["kv"]);
});

test("policy identity includes actual instructions and immutable skill/model configuration without credentials", () => {
  const f = fixture();
  const hash = runtime.sessionPolicyHash(f.session);
  f.session.model.baseUrl = "https://user:secret@example.com/v1?api_key=secret";
  assert.equal(runtime.sessionPolicyHash(f.session), hash);
  f.session.systemPrompt = "different system instructions";
  assert.notEqual(runtime.sessionPolicyHash(f.session), hash);
});

test("custom endpoint usage is unknown and later storage failure requires a new conversation", async () => {
  const f = fixture(); f.setExact(undefined);
  f.session.model.provider = "custom-openai";
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const first = await runAsk(f.session, "question");
  assert.deepEqual(first.metadata.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, quality: "unknown" });
  f.service.snapshot = async () => { throw new MemoryError("sqlite unavailable", 503); };
  await assert.rejects(runAsk(f.session, "again"), { code: "context_stale", reason: "validation_unavailable" });
  assert.equal(f.calls(), 1);
});

test("an interrupted replay keeps requiring a new conversation even with a new requestId", async () => {
  const f = fixture();
  const append = f.manager.appendMessage.bind(f.manager);
  f.manager.appendMessage = (message) => { if (message.role === "assistant") throw new Error("disk full"); return append(message); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where", undefined, undefined, { requestId: "partial" }));
  f.manager.appendMessage = append;
  await assert.rejects(runAsk(f.session, "where", undefined, undefined, { requestId: "partial" }));
  await assert.rejects(runAsk(f.session, "new question", undefined, undefined, { requestId: "new-request" }), { code: "request_conflict" });
  assert.equal(f.calls(), 0);
});

test("session factory attaches the shared lazy service and honors memory opt-out", async (t) => {
  const { createReadOnlySession } = await import("../src/session-factory.ts");
  const previous = process.env.CODE_ANALYZER_MEMORY;
  t.after(() => previous === undefined ? delete process.env.CODE_ANALYZER_MEMORY : process.env.CODE_ANALYZER_MEMORY = previous);
  delete process.env.CODE_ANALYZER_MEMORY;
  const enabled = await createReadOnlySession(process.cwd(), { resume: false, inMemory: true, llm: { baseUrl: "https://never.invalid/v1", model: "test" } });
  t.after(() => enabled.session.dispose());
  assert.equal(runtime.getSessionMemory(enabled.session)?.projectPath, process.cwd());
  process.env.CODE_ANALYZER_MEMORY = "off";
  const disabled = await createReadOnlySession(process.cwd(), { resume: false, inMemory: true, llm: { baseUrl: "https://never.invalid/v1", model: "test" } });
  t.after(() => disabled.session.dispose());
  assert.equal(runtime.getSessionMemory(disabled.session), undefined);
});

test("source change during a generated answer durably blocks later asks and restored bypass", async () => {
  const f = fixture(); f.setExact(undefined); f.service.search = async () => [];
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const prompt = f.session.prompt;
  f.session.prompt = async function (...args) { await prompt.apply(this, args); f.setSnapshot({ ...snapshot, key: "b", commit: "b" }); };
  await assert.rejects(runAsk(f.session, "first"), { code: "context_stale" });
  f.setSnapshot(snapshot);
  await assert.rejects(runAsk(f.session, "second", undefined, undefined, { reuse: "bypass" }), { code: "context_stale" });
  const restored = { ...f.session, agent: { transformContext: async (messages) => messages } };
  runtime.attachSessionMemory(restored, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(restored, "third", undefined, undefined, { reuse: "bypass" }), { code: "context_stale" });
  assert.equal(f.calls(), 1);
});

test("unavailable validation after a generated answer durably blocks continuation", async () => {
  const f = fixture(); f.setExact(undefined); f.service.search = async () => [];
  const snapshotBeforeFailure = f.service.snapshot;
  const prompt = f.session.prompt;
  f.session.prompt = async function (...args) {
    await prompt.apply(this, args);
    f.service.snapshot = async () => { throw new MemoryError("database unavailable", 503); };
  };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "first"), { code: "context_stale", reason: "validation_unavailable" });
  f.setSnapshot({ ...snapshot, key: "b", commit: "b" });
  f.service.snapshot = snapshotBeforeFailure;
  await assert.rejects(runAsk(f.session, "second"), { code: "context_stale" });
  assert.equal(f.calls(), 1);
});

test("revocation after exact transcript append marks the history stale", async () => {
  const f = fixture();
  const record = f.service.recordAnswer;
  f.service.recordAnswer = async (answer) => { await record(answer); f.setValid(false); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where"), { code: "context_stale" });
  f.setValid(true);
  await assert.rejects(runAsk(f.session, "again", undefined, undefined, { reuse: "bypass" }), { code: "context_stale" });
  assert.equal(f.calls(), 0);
});

test("unavailable final replay validation cannot fall through after transcript append", async () => {
  const f = fixture();
  const record = f.service.recordAnswer;
  f.service.recordAnswer = async (answer) => { await record(answer); f.service.snapshot = async () => { throw new MemoryError("database unavailable", 503); }; };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where"), { code: "context_stale" });
  f.service.snapshot = async () => snapshot;
  await assert.rejects(runAsk(f.session, "again"), { code: "context_stale" });
  assert.equal(f.calls(), 0);
});

test("semantic memory conflict never falls through to a model call", async () => {
  const f = fixture();
  f.service.lookupExact = async () => { throw new MemoryError("conflict", 409); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where"), { status: 409 });
  assert.equal(f.calls(), 0);
});

test("unexpected memory preparation errors do not silently call the model", async () => {
  const f = fixture();
  f.service.snapshot = async () => { throw new Error("unexpected invariant failure"); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where"), /unexpected invariant failure/);
  assert.equal(f.calls(), 0);
});

test("unsupported initial Git snapshot allows ordinary analysis without memory", async () => {
  const f = fixture();
  f.service.snapshot = async () => { throw new MemoryError("Cannot safely snapshot Git project", 400); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const answer = await runAsk(f.session, "first");
  assert.equal(answer.answer, "Final answer");
  assert.equal(answer.metadata, undefined);
  assert.equal(f.calls(), 1);
});

test("transient initial storage failure falls back before any trusted memory history", async () => {
  const f = fixture();
  f.service.snapshot = async () => { throw new MemoryError("database unavailable", 503); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  assert.equal((await runAsk(f.session, "first")).answer, "Final answer");
  assert.equal(f.calls(), 1);
});

test("unavailable initial snapshot after trusted history marks the session stale", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  f.service.snapshot = async () => { throw new MemoryError("database unavailable", 503); };
  await assert.rejects(runAsk(f.session, "second"), { code: "context_stale", reason: "validation_unavailable" });
  f.service.snapshot = async () => snapshot;
  await assert.rejects(runAsk(f.session, "third", undefined, undefined, { reuse: "bypass" }), { code: "context_stale" });
  assert.equal(f.calls(), 0);
});

test("unavailable used-knowledge validation cannot fall back with trusted history", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  f.service.validKnowledge = async () => { throw new MemoryError("database unavailable", 503); };
  await assert.rejects(runAsk(f.session, "second"), { code: "context_stale", reason: "validation_unavailable" });
  assert.equal(f.calls(), 0);
});

test("unavailable replay journal cannot fall back with trusted history", async () => {
  const f = fixture();
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await runAsk(f.session, "where");
  f.service.pendingReuses = async () => { throw new MemoryError("database unavailable", 503); };
  await assert.rejects(runAsk(f.session, "second"), { code: "context_stale", reason: "validation_unavailable" });
  assert.equal(f.calls(), 0);
});

test("unavailable replay journal cannot fall back after an incomplete begin marker", async () => {
  const f = fixture();
  f.manager.appendCustomEntry("answer_reuse_begin", { requestId: "partial", answerId: "partial-answer" });
  f.service.pendingReuses = async () => { throw new MemoryError("database unavailable", 503); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  await assert.rejects(runAsk(f.session, "where"), { code: "context_stale", reason: "validation_unavailable" });
  assert.equal(f.calls(), 0);
});

test("evidence budget includes serialized source text", async () => {
  const f = fixture(); f.setExact(undefined);
  f.service.search = async () => [{ ...knowledge, id: "large", versionId: "large-v", evidence: [{ path: "large.ts", startLine: 1, endLine: 1, blobHash: "blob", text: "文".repeat(3200) }] }, knowledge];
  let projected;
  const prompt = f.session.prompt;
  f.session.prompt = async function (...args) { projected = await this.agent.transformContext([{ role: "user", content: "question" }]); await prompt.apply(this, args); };
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const answer = await runAsk(f.session, "question");
  assert.deepEqual(answer.metadata.knowledgeIds, ["kv"]);
  assert.ok(JSON.stringify(projected).length < 3500);
});

test("nonempty generated answer with zero reported token deltas has unknown usage", async () => {
  const f = fixture(); f.setExact(undefined); f.service.search = async () => [];
  f.session.getSessionStats = () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  runtime.attachSessionMemory(f.session, { projectPath: "/project", service: f.service });
  const answer = await runAsk(f.session, "question");
  assert.deepEqual(answer.metadata.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, quality: "unknown" });
});
