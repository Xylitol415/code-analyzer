import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../src/api/client.ts";
const config = { baseUrl: "http://backend.test", token: "secret" };
test("memory requests carry bearer, scoped pagination, feedback and review revision", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { requests.push({ url, ...options }); return Response.json({}); });
  assert.equal(typeof api.listKnowledge, "function");
  await api.listKnowledge(config, "/project a", "needsreview", 20, 40);
  await api.getKnowledge(config, "knowledge/a");
  await api.collectAnswer(config, "answer/a");
  await api.putFeedback(config, "answer/a", { clientId: "anonymous", vote: "down", reason: "outdated", comment: "Changed" });
  await api.reviewKnowledge(config, "knowledge/a", { action: "publish", expectedRevision: 7, conditions: "Only serial queues", evidence: [{ path: "queue.ts", startLine: 2, endLine: 5 }] });
  assert.equal(requests[0].url, "http://backend.test/memory/knowledge?project=%2Fproject%20a&state=needsreview&limit=20&offset=40");
  assert.equal(requests[1].url, "http://backend.test/memory/knowledge/knowledge%2Fa");
  assert.deepEqual(JSON.parse(requests[2].body), { answerId: "answer/a" });
  assert.equal(requests[3].method, "PUT");
  assert.equal(requests[3].url, "http://backend.test/memory/answers/answer%2Fa/feedback");
  assert.deepEqual(JSON.parse(requests[3].body), { clientId: "anonymous", vote: "down", reason: "outdated", comment: "Changed" });
  assert.deepEqual(JSON.parse(requests[4].body), { action: "publish", expectedRevision: 7, conditions: "Only serial queues", evidence: [{ path: "queue.ts", startLine: 2, endLine: 5 }] });
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer secret"));
});
test("memory errors retain actionable unsupported and CAS conflict detail", async (t) => {
  assert.equal(typeof api.reviewKnowledge, "function");
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Revision conflict: refresh" }, { status: 409 }));
  await assert.rejects(() => api.reviewKnowledge(config, "id", { action: "withdraw", expectedRevision: 1 }), /Revision conflict/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Memory unavailable on this Node version" }, { status: 503 }));
  await assert.rejects(() => api.listKnowledge(config, "/project"), /Memory unavailable/);
});
