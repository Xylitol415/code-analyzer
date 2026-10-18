import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createApp } from "../src/server.js";
import { closeSession, getSession } from "../src/session-registry.js";
import { createReadOnlySession } from "../src/session-factory.js";

const token = "history-test-token";
const llm = { baseUrl: "https://history-test.invalid/v1", model: "selected-model", apiKey: "synthetic-history-secret" };
const greeting = "会话已建立。请用简短友好的中文向用户打个招呼，介绍你是只读的代码逻辑分析助手，能帮他分析项目整体架构、追踪调用链、解释某段代码逻辑、查看代码演进历史等，并邀请他开始提问。不要冗长。";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "code-analyzer-history-"));
  const project = join(directory, "project");
  const otherProject = join(directory, "other-project");
  await Promise.all([project, otherProject].map((path) => mkdir(join(path, ".git"), { recursive: true })));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  const ids = new Set<string>();
  t.after(async () => {
    for (const id of ids) await closeSession(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const app = createApp(token);
  const post = async (body) => {
    const response = await app.request("/sessions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ project, llm, ...body }),
    });
    const result = await response.json();
    if (response.ok) ids.add(result.id);
    return { response, result };
  };
  const list = (path = project) => app.request(`/history?project=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } });
  return { directory, project, otherProject, app, post, list };
}

function assistant(text, stopReason = "stop", extra = {}) {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "old-provider", model: "old-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1000, ...extra,
  };
}

function history(project, question, timestamp = 1000) {
  const manager = SessionManager.create(project);
  manager.appendModelChange("old-provider", "old-model");
  manager.appendMessage({ role: "user", content: question, timestamp });
  manager.appendMessage(assistant("Existing answer", "stop", { timestamp: timestamp + 1 }));
  return manager;
}

test("history listing is authenticated, project-scoped, newest first and hides automatic prompts and disk paths", async (t) => {
  const { project, otherProject, app, list } = await setup(t);
  const first = history(project, greeting);
  first.appendMessage({ role: "user", content: "Explain the election algorithm", timestamp: 2000 });
  first.appendMessage(assistant("Election explanation", "stop", { timestamp: 2001 }));
  const second = history(project, "Second question", 3000);
  second.appendSessionInfo("Named discussion");
  history(otherProject, "Another project", 4000);
  const before = await readFile(first.getSessionFile()!, "utf8");
  assert.equal((await app.request(`/history?project=${encodeURIComponent(project)}`)).status, 401);
  const response = await list();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.projectPath, project);
  assert.deepEqual(result.sessions.map((s) => s.id), [second.getSessionId(), first.getSessionId()]);
  assert.deepEqual(result.sessions.map((s) => s.title), ["Named discussion", "Explain the election algorithm"]);
  assert.equal(result.sessions[1].modelLabel, "old-provider/old-model");
  assert.equal(result.sessions[1].messageCount, 3);
  assert.doesNotMatch(JSON.stringify(result.sessions), /\.jsonl|会话已建立|synthetic-history-secret/);
  assert.equal(await readFile(first.getSessionFile()!, "utf8"), before);
});

test("selected history restores visible turns and completed tools without calling a model or reverting the selected model", async (t) => {
  const { project, post } = await setup(t);
  const manager = history(project, "Inspect the code");
  manager.appendMessage({ role: "user", content: "Read then explain", timestamp: 2000 });
  manager.appendMessage(assistant("", "toolUse", { content: [
    { type: "thinking", thinking: "Reading" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
  ] }));
  manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "file content" }], isError: false, timestamp: 2001 });
  manager.appendMessage(assistant("Partial reply", "aborted", { timestamp: 2002 }));
  history(project, "More recent unrelated history", 3000);
  const { response, result } = await post({ historyId: manager.getSessionId() });
  assert.equal(response.status, 200);
  assert.equal(result.historyId, manager.getSessionId());
  assert.equal(result.resumed, true);
  assert.equal(result.modelLabel, "custom-openai/selected-model");
  assert.deepEqual(result.messages.map((m) => [m.role, m.content]), [
    ["user", "Inspect the code"], ["assistant", "Existing answer"], ["user", "Read then explain"], ["assistant", "Partial reply"],
  ]);
  assert.deepEqual(result.messages[3].tools, [{ name: "read", args: { path: "README.md" }, isError: false }]);
  assert.equal(result.messages[3].thinking, "Reading");
  assert.equal(result.messages[3].stopped, true);
  assert.ok(result.messages.every((m) => m.streaming === false));
  assert.equal(getSession(result.id)?.session.messages.filter((m) => m.role === "user").length, 2);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-history-secret/);
});

test("invalid, missing and cross-project history IDs fail without falling back to a new or latest session", async (t) => {
  const { project, otherProject, post, list } = await setup(t);
  history(project, "Current project");
  const foreign = history(otherProject, "Other project");
  for (const historyId of ["", "../outside.jsonl", "/tmp/session.jsonl", null, 123]) {
    assert.equal((await post({ historyId })).response.status, 400);
  }
  for (const historyId of [randomUUID(), foreign.getSessionId()]) {
    assert.equal((await post({ historyId })).response.status, 404);
  }
  assert.equal((await post({ historyId: foreign.getSessionId(), resume: true })).response.status, 400);
  assert.equal((await list("/missing-history-project")).status, 400);
});

test("concurrent opens of one history are rejected until its live session is released", async (t) => {
  const { project, post, list } = await setup(t);
  const manager = history(project, "Shared history");
  const results = await Promise.all([post({ historyId: manager.getSessionId() }), post({ historyId: manager.getSessionId() })]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  const opened = results.find((r) => r.response.ok)!.result;
  assert.equal((await (await list()).json()).sessions[0].active, true);
  await closeSession(opened.id);
  assert.equal((await post({ historyId: manager.getSessionId() })).response.status, 200);
});

test("new sessions return no history and legacy resume opens the latest persisted conversation", async (t) => {
  const { project, post } = await setup(t);
  history(project, "Older", 1000);
  const latest = history(project, "Latest", 2000);
  const created = await post({});
  assert.equal(created.response.status, 200);
  assert.equal(typeof created.result.historyId, "string");
  assert.equal(created.result.resumed, false);
  assert.deepEqual(created.result.messages, []);
  const resumed = await post({ resume: true });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.result.historyId, latest.getSessionId());
  assert.equal(resumed.result.messages[0].content, "Latest");
});

test("listing an unused project or remote URL creates neither storage nor a clone", async (t) => {
  const { directory, list } = await setup(t);
  assert.deepEqual((await (await list()).json()).sessions, []);
  const remote = await list(`https://history-test.invalid/${randomUUID()}.git`);
  assert.equal(remote.status, 200);
  const result = await remote.json();
  assert.deepEqual(result.sessions, []);
  await assert.rejects(stat(result.projectPath), { code: "ENOENT" });
  await assert.rejects(stat(join(directory, "agent")), { code: "ENOENT" });
});

test("explicit history cannot be silently discarded for an in-memory session", async (t) => {
  const { project } = await setup(t);
  const manager = history(project, "Keep this context");
  await assert.rejects(createReadOnlySession(project, {
    resume: false, inMemory: true, historyId: manager.getSessionId(), llm,
  }), { name: "HistoryError" });
});

test("HTTP sessionId retries are idempotent only for the same project and selected history", async (t) => {
  const { project, otherProject, post } = await setup(t);
  const first = history(project, "First history");
  const second = history(project, "Second history");
  const sessionId = "history-idempotent-runtime";
  const opened = await post({ sessionId, historyId: first.getSessionId() });
  assert.equal(opened.response.status, 200);
  const repeated = await post({ sessionId, historyId: first.getSessionId() });
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.result, opened.result);
  assert.equal((await post({ sessionId, historyId: second.getSessionId() })).response.status, 409);
  assert.equal((await post({ sessionId, project: otherProject })).response.status, 409);
  assert.equal(getSession(sessionId)?.historyId, first.getSessionId());
});

test("HTTP concurrent reuse of a runtime ID cannot overwrite a live session or leave history occupied", async (t) => {
  const { project, post, list, app } = await setup(t);
  const first = history(project, "First concurrent history");
  const second = history(project, "Second concurrent history");
  const sessionId = "history-concurrent-runtime";
  const results = await Promise.all([first, second].map((manager) => post({ sessionId, historyId: manager.getSessionId() })));
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  const succeeded = results.find((r) => r.response.ok)!.result;
  assert.equal(getSession(sessionId)?.historyId, succeeded.historyId);
  const closed = await app.request(`/sessions/${sessionId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await closed.json(), { ok: true });
  assert.ok((await (await list()).json()).sessions.every((session) => !session.active));
  const reopened = await post({ sessionId, historyId: second.getSessionId() });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.result.historyId, second.getSessionId());
});

test("HTTP initialization failure releases both runtime ID and selected-history reservations", async (t) => {
  const { project, post } = await setup(t);
  const manager = history(project, "Retry after failed initialization");
  const sessionId = "history-failed-runtime";
  const failed = await post({ sessionId, historyId: manager.getSessionId(), llm: undefined, modelId: "unknown-history-provider/missing-model" });
  assert.equal(failed.response.status, 500);
  const retried = await post({ sessionId, historyId: manager.getSessionId() });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.result.historyId, manager.getSessionId());
});
