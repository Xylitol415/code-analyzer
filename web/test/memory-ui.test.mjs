import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { ChatMessage } from "../src/components/ChatMessage.tsx";
const config = { baseUrl: "http://original.test", token: "secret" };
const binding = { config, project: "/project", connected: true };
const snapshot = { projectPath: "/project", projectId: "project-id", branch: "main", commit: "a".repeat(40), key: "source-key", clean: true };
const item = { id: "k/1", versionId: "version-1", revision: 4, state: "candidate", question: "How is the queue drained?", answer: "In order", conditions: "Only serial mode", snapshot, policyHash: "policy", evidence: [{ path: "queue.ts", startLine: 2, endLine: 3, blobHash: "blob", text: "immutable code" }], sourceAnswerId: "answer-1", createdAt: "2026-10-19", updatedAt: "2026-10-19", up: 1, down: 0 };
function text(node) { return typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node?.children?.map(text).join("") ?? ""; }
async function setup(t, Component, props, initialVote = null) {
  const requests = [], stored = new Map();
  t.mock.method(globalThis, "fetch", (url, options = {}) => {
    if (String(url).includes("/feedback?clientId=")) return Promise.resolve(Response.json({ vote: initialVote, up: 0, down: 0 }));
    return new Promise((resolve) => requests.push({ url, ...options, reply: (body, status = 200) => resolve(Response.json(body, { status })) }));
  });
  const oldWindow = globalThis.window, oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const log = console.error;
  t.mock.method(console, "error", (...args) => { if (!String(args[0]).startsWith("react-test-renderer is deprecated")) log(...args); });
  let root;
  await act(async () => { root = create(React.createElement(Component, { ...props, key: "first" })); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.window = oldWindow; if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage; globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct; });
  const h = { requests, stored, get root() { return root.root; }, get text() { return text(root.toJSON()); }, button(label) { return root.root.findAllByType("button").find((node) => node.props["aria-label"] === label || text(node) === label); }, async click(label) { const b = h.button(label); assert.ok(b, `Missing button ${label}`); assert.ok(!b.props.disabled); await act(async () => { void b.props.onClick(); }); }, async input(label, value) { await act(async () => h.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })); }, async reply(i, body, status) { await act(async () => requests[i].reply(body, status)); }, async replace(nextProps) { await act(async () => root.update(React.createElement(Component, { ...nextProps, key: "next" }))); } };
  return h;
}
const message = { id: "local", role: "assistant", content: "Answer", thinking: "", tools: [], streaming: false, answerId: "answer/1", source: "exact", knowledgeIds: ["k1"] };
test("completed backend answers expose feedback, optional negative details, clear and manual collection", async (t) => {
  const h = await setup(t, ChatMessage, { message, config });
  assert.match(h.text, /已审核知识直接复用/);
  assert.equal(h.root.findAllByType("button").length, 3, "reply toolbar has copy, rating, and knowledge icons only");
  assert.equal(h.button("有帮助"), undefined);
  assert.equal(h.button("评价回复").props["aria-haspopup"], "menu");
  assert.equal(text(h.button("收录为候选知识")), "");
  await h.click("评价回复");
  await h.click("有帮助");
  const up = JSON.parse(h.requests[0].body);
  assert.match(up.clientId, /^[0-9a-f-]{36}$/);
  assert.equal(up.vote, "up");
  assert.equal(h.requests[0].headers.Authorization, "Bearer secret");
  await h.reply(0, { vote: "up", up: 1, down: 0, knowledgeId: "k1" });
  assert.equal(h.button("评价回复").props["aria-expanded"], false);
  await h.click("评价回复");
  assert.equal(h.button("有帮助").props["aria-checked"], true);
  await h.click("无帮助");
  await h.input("负面反馈原因", "outdated");
  await h.input("反馈补充说明", "Code changed");
  await h.click("提交负面反馈");
  assert.deepEqual(JSON.parse(h.requests[1].body), { clientId: up.clientId, vote: "down", reason: "outdated", comment: "Code changed" });
  await h.reply(1, { vote: "down", up: 0, down: 1 });
  await h.click("评价回复");
  assert.equal(h.button("无帮助").props["aria-checked"], true);
  await h.click("清除反馈");
  assert.deepEqual(JSON.parse(h.requests[2].body), { clientId: up.clientId, vote: null });
  await h.reply(2, { vote: null, up: 0, down: 0 });
  await h.click("收录为候选知识");
  assert.deepEqual(JSON.parse(h.requests[3].body), { answerId: "answer/1" });
  await h.reply(3, item);
  assert.match(h.text, /已收录为候选/);
  assert.equal(h.stored.size, 1);
  assert.equal([...h.stored.values()][0], up.clientId);
});
test("stopped, failed, streaming and legacy answers cannot receive feedback", async (t) => {
  const h = await setup(t, ChatMessage, { message: { ...message, stopped: true }, config });
  for (const overrides of [{ stopped: true }, { error: "failed" }, { streaming: true }, { answerId: undefined }]) {
    await h.replace({ message: { ...message, ...overrides }, config });
    assert.equal(h.button("评价回复"), undefined);
    assert.equal(h.button("收录为候选知识"), undefined);
  }
});
test("feedback survives unavailable local storage and late replies cannot reach a replaced scope", async (t) => {
  const h = await setup(t, ChatMessage, { message, config });
  globalThis.localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  await h.click("评价回复");
  await h.click("有帮助");
  await h.replace({ message: { ...message, answerId: "new-answer" }, config: { baseUrl: "http://next.test", token: "next" } });
  await h.reply(0, { vote: "up", up: 1, down: 0 });
  await h.click("评价回复");
  assert.equal(h.button("有帮助").props["aria-checked"], false);
  await h.click("有帮助");
  assert.equal(h.requests[1].url, "http://next.test/memory/answers/new-answer/feedback");
});
test("review edits submit CAS revision and fixed evidence coordinates while source snippets stay immutable", async (t) => {
  const { KnowledgeManager } = await import("../src/components/KnowledgeManager.tsx").catch(() => ({}));
  assert.equal(typeof KnowledgeManager, "function");
  const h = await setup(t, KnowledgeManager, { binding });
  await h.click("知识库管理");
  await h.reply(0, { projectPath: "/project", snapshot, items: [item], total: 1, indexAvailable: false, indexError: "Index unavailable" });
  assert.match(h.text, /Index unavailable/);
  await h.click(item.question);
  await h.reply(1, item);
  assert.match(h.text, /immutable code/);
  assert.match(h.text, /main/);
  assert.match(h.text, /version-1/);
  await h.input("适用条件", "Only in serial queue mode");
  await h.input("证据 1 起始行", "4");
  await h.input("证据 1 结束行", "6");
  assert.equal(h.button("发布知识").props.disabled, true);
  await h.click("核验源码");
  assert.deepEqual(JSON.parse(h.requests[2].body), { expectedRevision: 4, expectedSourceKey: snapshot.key, evidence: [{ path: "queue.ts", startLine: 4, endLine: 6 }] });
  await h.reply(2, { snapshot, evidence: [{ ...item.evidence[0], startLine: 4, endLine: 6, text: "verified fixed source" }] });
  assert.match(h.text, /verified fixed source/);
  await h.click("发布知识");
  assert.deepEqual(JSON.parse(h.requests[3].body), { expectedRevision: 4, action: "publish", question: item.question, answer: item.answer, conditions: "Only in serial queue mode", evidence: [{ path: "queue.ts", startLine: 4, endLine: 6 }], expectedSourceKey: snapshot.key });
  await h.reply(3, { error: "Revision conflict: refresh" }, 409);
  assert.match(h.text, /Revision conflict/);
  assert.equal(h.root.findByProps({ "aria-label": "适用条件" }).props.value, "Only in serial queue mode");
  await h.click("刷新知识详情");
  await h.reply(4, { ...item, revision: 5 });
  await h.click("撤回知识");
  assert.deepEqual(JSON.parse(h.requests[5].body), { expectedRevision: 5, action: "withdraw" });
});

test("feedback restored from the backend can be cleared after a page reload", async t => {
  const h = await setup(t, ChatMessage, { message, config }, "up");
  await h.click("评价回复");
  assert.equal(h.button("有帮助").props["aria-checked"], true);
  assert.equal(h.button("清除反馈").props.disabled, false);
  await h.click("清除反馈");
  assert.equal(JSON.parse(h.requests[0].body).vote, null);
});

test("rating menu closes with Escape and cancelled negative details never submit feedback", async t => {
  const h = await setup(t, ChatMessage, { message, config });
  await h.click("评价回复");
  assert.equal(h.button("清除反馈"), undefined, "no revoke option before any vote");
  await act(async () => h.root.findByProps({ role: "menu" }).props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
  assert.equal(h.button("评价回复").props["aria-expanded"], false);
  await h.click("评价回复");
  await h.click("无帮助");
  assert.equal(h.root.findByProps({ "aria-label": "反馈详情" }).props.role, "dialog");
  await h.input("反馈补充说明", "Draft only");
  await h.click("取消");
  assert.equal(h.root.findByProps({ "aria-label": "评价回复选项" }).props.role, "menu");
  assert.equal(h.requests.length, 0);
});

test("failed feedback remains retryable in the menu and submitting does not duplicate requests", async t => {
  const h = await setup(t, ChatMessage, { message, config });
  await h.click("评价回复");
  await h.click("有帮助");
  assert.equal(h.button("有帮助").props.disabled, true);
  await h.reply(0, { error: "Please retry" }, 500);
  assert.equal(h.button("评价回复").props["aria-expanded"], true);
  assert.match(h.text, /Please retry/);
  assert.equal(h.button("有帮助").props["aria-checked"], false);
  await h.click("有帮助");
  assert.equal(h.requests.length, 2);
  await h.reply(1, { vote: "up", up: 1, down: 0 });
  assert.equal(h.button("评价回复").props["aria-expanded"], false);
});
test("knowledge library scopes loading, detail and review replies to the active binding", async (t) => {
  const { KnowledgeManager } = await import("../src/components/KnowledgeManager.tsx").catch(() => ({}));
  assert.equal(typeof KnowledgeManager, "function");
  const h = await setup(t, KnowledgeManager, { binding });
  await h.click("知识库管理");
  await h.replace({ binding: { config: { baseUrl: "http://next.test", token: "next" }, project: "/next", connected: true } });
  await h.reply(0, { projectPath: "/project", snapshot, items: [item], total: 1, indexAvailable: true });
  assert.doesNotMatch(h.text, /How is the queue/);
  await h.click("知识库管理");
  assert.equal(h.requests[1].url, "http://next.test/memory/knowledge?project=%2Fnext&state=candidate&limit=20&offset=0");
  await h.reply(1, { projectPath: "/next", snapshot: { ...snapshot, projectPath: "/next" }, items: [], total: 0, indexAvailable: true });
  assert.match(h.text, /暂无/);
  await h.click("待复核");
  assert.match(h.requests[2].url, /state=needsreview/);
});

test("closing during review leaves the reopened library usable after the reply", async t => {
  const { KnowledgeManager } = await import("../src/components/KnowledgeManager.tsx");
  const h = await setup(t, KnowledgeManager, { binding });
  await h.click("知识库管理");
  await h.reply(0, { projectPath: "/project", snapshot, items: [item], total: 1, indexAvailable: true });
  await h.click(item.question);
  await h.reply(1, item);
  await h.click("撤回知识");
  await h.click("关闭知识库");
  await h.reply(2, { ...item, revision: 5, state: "withdrawn" });
  await h.click("知识库管理");
  await h.reply(3, { projectPath: "/project", snapshot, items: [item], total: 1, indexAvailable: true });
  assert.equal(h.button(item.question).props.disabled, false);
});
