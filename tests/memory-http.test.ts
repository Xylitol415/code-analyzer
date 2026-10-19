import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { MemoryEngine } from "../src/memory/engine.js";
import { ZvecKnowledgeIndex } from "../src/memory/index.js";
import type { AnswerRecord } from "../src/memory/types.js";

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const routes = await import("../src/memory-routes.js").catch(() => undefined);
  assert.ok(routes?.createMemoryRoutes, "memory HTTP routes must exist");
  const path = await realpath(await mkdtemp(join(tmpdir(), "memory-http-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
  git("init", "-q");
  await writeFile(join(path, "feature.ts"), "export const enabled = true;\n");
  git("add", "feature.ts");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  const dataDir = await mkdtemp(join(tmpdir(), "memory-http-data-"));
  const service = new MemoryEngine({ dataDir, index: new ZvecKnowledgeIndex({ dataDir }) });
  t.after(async () => { await service.close(); await rm(path, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); });
  const app = new Hono().route("/memory", routes.createMemoryRoutes(service));
  const snapshot = await service.snapshot(path);
  const record: AnswerRecord = { id: "answer-http", version: "version-http", requestId: "request-http", historyId: "history-http", question: "代码是否默认启用？", answer: "默认启用，见 feature.ts:1。", status: "completed", source: "generated", snapshot, policyHash: "policy-http", knowledgeIds: [], assistantEntryIds: ["asst-entry"], usage: { input: null, output: null, cacheRead: null, cacheWrite: null, quality: "unknown" }, elapsedMs: 10, createdAt: new Date().toISOString() };
  await service.recordAnswer(record);
  const json = (url: string, body: unknown, method = "POST") => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, service, path, json };
}

test("memory routes create reviewed knowledge, preserve CAS and suspend a negatively rated exact answer", async t => {
  const { app, service, path, json } = await fixture(t);
  assert.equal((await app.request("/memory/knowledge")).status, 400);
  const feedback = await json("/memory/answers/answer-http/feedback", { clientId: "client-http", vote: "up" }, "PUT");
  assert.equal(feedback.status, 200, await feedback.clone().text());
  assert.equal((await (await app.request("/memory/answers/answer-http/feedback?clientId=client-http")).json()).vote, "up");
  const candidate = await (await json("/memory/knowledge", { answerId: "answer-http" })).json();
  const evidence = await json(`/memory/knowledge/${candidate.id}/evidence`, { expectedRevision: candidate.revision, expectedSourceKey: candidate.snapshot.key, evidence: [{ path: "feature.ts", startLine: 1, endLine: 1 }] });
  assert.equal(evidence.status, 200, await evidence.clone().text());
  assert.match((await evidence.json()).evidence[0].text, /enabled = true/);
  const publishedResponse = await json(`/memory/knowledge/${candidate.id}/review`, { expectedRevision: candidate.revision, action: "publish", conditions: "仅固定源码版本的静态事实", evidence: [{ path: "feature.ts", startLine: 1, endLine: 1 }] });
  assert.equal(publishedResponse.status, 200, await publishedResponse.clone().text());
  const published = await publishedResponse.json();
  assert.equal(published.state, "published");
  assert.match(published.evidence[0].text, /enabled = true/);
  const list = await app.request(`/memory/knowledge?project=${encodeURIComponent(path)}&state=published`);
  assert.equal((await list.json()).items[0].versionId, published.versionId);
  assert.equal((await json(`/memory/knowledge/${candidate.id}/review`, { expectedRevision: candidate.revision, action: "withdraw" })).status, 409);
  const original = await service.getAnswer("answer-http");
  await service.recordAnswer({ ...original!, id: "answer-exact", requestId: "request-exact", source: "exact", knowledgeIds: [published.versionId] });
  const down = await json("/memory/answers/answer-exact/feedback", { clientId: "client-http", vote: "down", reason: "incorrect" }, "PUT");
  assert.equal(down.status, 200);
  assert.equal(await service.validKnowledge([published.versionId]), false);
  assert.equal((await service.getKnowledge(candidate.id)).feedback?.some(entry => entry.reason === "incorrect"), true);
});

test("memory routes reject malformed feedback and untrusted evidence without changing knowledge", async t => {
  const { json, app } = await fixture(t);
  assert.equal((await json("/memory/answers/answer-http/feedback", { clientId: "client-http", vote: "admin" }, "PUT")).status, 400);
  assert.equal((await json("/memory/knowledge", { answerId: "missing-answer" })).status, 404);
  const candidate = await (await json("/memory/knowledge", { answerId: "answer-http" })).json();
  const invalid = await json(`/memory/knowledge/${candidate.id}/review`, { expectedRevision: candidate.revision, action: "publish", conditions: "test", evidence: [{ path: "../outside", startLine: 1, endLine: 1 }] });
  assert.equal(invalid.status, 400);
  assert.equal((await (await app.request(`/memory/knowledge/${candidate.id}`)).json()).state, "candidate");
  const tooLarge = await app.request("/memory/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answerId: "x".repeat(600_000) }) });
  assert.equal(tooLarge.status, 413);
});
