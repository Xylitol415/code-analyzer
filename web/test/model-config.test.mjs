import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { create } from "react-test-renderer";
import App from "../src/App.tsx";
import { createSession, deleteSession, listModels } from "../src/api/client.ts";

const modelList = {
  models: [
    { provider: "openai-codex", id: "gpt-5", name: "GPT-5" },
    { provider: "openai-codex", id: "gpt-5-mini", name: "GPT-5 mini" },
  ],
  default: "openai-codex/gpt-5-mini",
};

function visibleText(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleText).join("");
  return node?.children?.map(visibleText).join("") ?? "";
}

async function setup(t, { openConfig = true, autoRelease = true } = {}) {
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  t.mock.method(globalThis, "fetch", (url, options = {}) => new Promise((resolve) => {
    requests.push({ url, ...options, reply: (body, status = 200) => resolve(Response.json(body, { status })) });
    if (options.method === "DELETE" && autoRelease) resolve(Response.json({ ok: true }));
    if (url.endsWith("/ask")) resolve(new Response("", { headers: { "content-type": "text/event-stream" } }));
  }));
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const lifecycle = new EventTarget();
  globalThis.window = {
    fetch: globalThis.fetch,
    addEventListener: lifecycle.addEventListener.bind(lifecycle),
    removeEventListener: lifecycle.removeEventListener.bind(lifecycle),
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.document = { removeEventListener() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const originalError = console.error;
  t.mock.method(console, "error", (...args) => {
    if (String(args[0]).startsWith("react-test-renderer is deprecated")) return;
    originalError(...args);
  });
  let root;
  await act(async () => { root = create(React.createElement(App)); });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldActEnvironment;
  });
  const findButton = (label) => root.root.findAllByType("button").find((button) => visibleText(button) === label);
  const harness = {
    requests,
    get select() { return root.root.findByType("select"); },
    get connect() { return root.root.findAllByType("button").find((button) => button.props["aria-label"] === "连接会话" || button.children.includes("建会话")); },
    get models() { return root.root.findAllByType("option").filter((option) => option.props.value).map((option) => option.props.value); },
    get text() { return JSON.stringify(root.toJSON()); },
    get visibleText() { return visibleText(root.toJSON()); },
    get configButton() { return findButton("会话配置"); },
    get dialogs() { return root.root.findAllByProps({ role: "dialog", "aria-label": "会话配置" }); },
    get historyOptions() { return root.root.findAllByProps({ name: "history-session" }); },
    async clickButton(label) {
      const button = findButton(label);
      assert.ok(button, `Expected a ${label} button`);
      await act(async () => { void button.props.onClick(); });
    },
    async openSkills() { await act(async () => { root.root.findByProps({ "aria-label": "Skills 管理" }).props.onClick(); }); },
    async closeSkills() { await act(async () => { root.root.findByProps({ "aria-label": "关闭 Skills" }).props.onClick(); }); },
    async openHistory() { await act(async () => { root.root.findByProps({ "aria-label": "历史会话" }).props.onClick(); }); },
    async sessionMode(value) { await act(async () => { root.root.findByProps({ name: "session-mode", value }).props.onChange(); }); },
    async selectHistory(id) { await act(async () => { root.root.findByProps({ name: "history-session", value: id }).props.onChange(); }); },
    async refreshHistory() { await act(async () => { findButton("刷新列表").props.onClick(); }); },
    get configInputs() { return root.root.findAllByProps({ placeholder: "Token" }); },
    inputValue(placeholder) { return root.root.findByProps({ placeholder }).props.value; },
    async openConfig() { await act(async () => { findButton("会话配置").props.onClick(); }); },
    async closeConfig() {
      await act(async () => { root.root.findByProps({ "aria-label": "关闭配置" }).props.onClick(); });
    },
    async newSession() { await act(async () => { findButton("新建会话").props.onClick(); }); },
    async input(placeholder, value) {
      await act(async () => { root.root.findByProps({ placeholder }).props.onChange({ target: { value } }); });
    },
    inputType(placeholder) { return root.root.findByProps({ placeholder }).props.type; },
    async mode(value) {
      await act(async () => { root.root.findByProps({ type: "radio", value }).props.onChange(); });
    },
    async clickConnect() {
      await act(async () => { void harness.connect.props.onClick(); });
    },
    async flushTimers() {
      await act(async () => {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach((callback) => callback());
      });
    },
    async reply(index, body, status) { await act(async () => { requests[index].reply(body, status); }); },
  };
  if (openConfig) await harness.openConfig();
  return harness;
}

async function configureCustomSession(h, project = "/connected-project") {
  await h.input("项目路径 或 git URL", project);
  await h.input("Token", "backend-token");
  await h.mode("custom");
  await h.input("LLM BaseURL", "http://gateway.test/v1");
  await h.input("LLM API Key（可选）", "session-secret");
  await h.input("模型名", "org/custom-model");
}

test("session configuration starts collapsed and opens from the compact toolbar", async (t) => {
  const h = await setup(t, { openConfig: false });
  assert.equal(h.configButton?.props["aria-expanded"], false);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.configInputs.length, 0);
  assert.equal(h.requests.length, 0);
  await h.openConfig();
  assert.equal(h.configButton.props["aria-expanded"], true);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.configInputs.length, 1);
});

test("closing configuration keeps the entered project and LLM credentials for reopening", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.closeConfig();
  assert.equal(h.configButton.props["aria-expanded"], false);
  assert.equal(h.dialogs.length, 0);
  await h.openConfig();
  assert.equal(h.inputValue("项目路径 或 git URL"), "/connected-project");
  assert.equal(h.inputValue("Token"), "backend-token");
  assert.equal(h.inputValue("LLM BaseURL"), "http://gateway.test/v1");
  assert.equal(h.inputValue("LLM API Key（可选）"), "session-secret");
  assert.equal(h.inputValue("模型名"), "org/custom-model");
});

test("failed session creation keeps configuration open and successful retry collapses it", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.clickConnect();
  const first = h.requests.findIndex((request) => request.method === "POST");
  await h.reply(first, { error: "project does not exist" }, 400);
  assert.equal(h.dialogs.length, 1);
  const alerts = h.dialogs[0].findAllByProps({ role: "alert" });
  assert.ok(alerts.some((alert) => visibleText(alert).includes("project does not exist")),
    "session errors must be visible inside the modal, above the browser top layer backdrop");
  assert.equal(h.inputValue("模型名"), "org/custom-model");
  await h.clickConnect();
  const retry = h.requests.findLastIndex((request) => request.method === "POST");
  await h.reply(retry, { id: "connected-session", modelLabel: "actual-model", resumed: false });
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.configButton.props["aria-expanded"], false);
  assert.match(h.visibleText, /已连接/);
  assert.match(h.visibleText, /actual-model/);
});

test("session summary keeps connected values and starting a new session releases it and opens configuration", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.clickConnect();
  const create = h.requests.findIndex((request) => request.method === "POST");
  await h.reply(create, { id: "connected-session", modelLabel: "actual-model", resumed: false });
  await h.openConfig();
  await h.input("项目路径 或 git URL", "/draft-project");
  await h.input("模型名", "draft-model");
  await h.closeConfig();
  assert.match(h.visibleText, /connected-project/);
  assert.match(h.visibleText, /actual-model/);
  assert.doesNotMatch(h.visibleText, /draft-project|draft-model/);
  await h.newSession();
  const cleanup = h.requests.find((request) => request.method === "DELETE");
  assert.ok(cleanup?.url.endsWith("/sessions/connected-session"));
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.configButton.props["aria-expanded"], true);
  assert.equal(h.inputValue("项目路径 或 git URL"), "/draft-project");
  assert.equal(h.inputValue("模型名"), "draft-model");
  assert.doesNotMatch(h.visibleText, /已连接/);
});

test("no token shows no invented models and cannot create a session", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  assert.deepEqual(h.models, []);
  assert.equal(h.select.props.disabled, true);
  assert.equal(h.connect.props.disabled, true);
  assert.equal(h.requests.length, 0);
});

test("unauthorized model discovery explains the backend token and blocks session creation", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("Token", "wrong-token");
  await h.flushTimers();
  await h.reply(0, { error: "unauthorized" }, 401);
  assert.deepEqual(h.models, []);
  assert.match(h.text, /401/);
  assert.match(h.text, /后端.*Token/);
  assert.match(h.text, /--token/);
  assert.equal(h.connect.props.disabled, true);
});

test("only the discovered models enable connection and the server default is selected", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("后端地址", "  http://example.test///  ");
  await h.input("Token", "  valid-token  ");
  assert.equal(h.connect.props.disabled, true);
  await h.flushTimers();
  assert.equal(h.requests[0].url, "http://example.test/models");
  assert.equal(h.requests[0].headers.Authorization, "Bearer valid-token");
  await h.reply(0, modelList);
  assert.deepEqual(h.models, ["openai-codex/gpt-5", "openai-codex/gpt-5-mini"]);
  assert.equal(h.select.props.value, "openai-codex/gpt-5-mini");
  assert.equal(h.connect.props.disabled, false);
});

test("changing backend configuration removes old options immediately and ignores stale discovery", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("Token", "first-token");
  await h.flushTimers();
  await h.reply(0, modelList);
  await h.input("Token", "second-token");
  assert.deepEqual(h.models, []);
  assert.equal(h.connect.props.disabled, true);
  await h.flushTimers();
  await h.input("后端地址", "http://another.test");
  await h.flushTimers();
  await h.reply(2, { models: [modelList.models[0]], default: "missing/model" });
  await h.reply(1, { error: "unauthorized" }, 401);
  assert.deepEqual(h.models, ["openai-codex/gpt-5"]);
  assert.equal(h.select.props.value, "openai-codex/gpt-5");
  assert.equal(h.connect.props.disabled, false);
  assert.doesNotMatch(h.text, /401/);
});

test("an empty model list remains empty and directs the user to backend model credentials", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("Token", "valid-token");
  await h.flushTimers();
  await h.reply(0, { models: [], default: "missing/model" });
  assert.deepEqual(h.models, []);
  assert.equal(h.connect.props.disabled, true);
  assert.match(h.text, /模型.*凭据/);
});

test("HTTP operations surface actionable backend authentication errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  const config = { baseUrl: "http://example.test", token: "wrong-token" };
  for (const operation of [
    () => listModels(config),
    () => createSession(config, "/project"),
    () => deleteSession(config, "session-1"),
  ]) {
    await assert.rejects(operation, (error) => /401/.test(error.message) && /--token/.test(error.message));
  }
});

test("custom OpenAI-compatible sessions submit their own configuration even when model discovery fails", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("Token", "backend-token");
  await h.flushTimers();
  await h.reply(0, { error: "model registry unavailable" }, 500);
  await h.mode("custom");
  await h.input("LLM BaseURL", "  http://gateway.test/v1/  ");
  await h.input("LLM API Key（可选）", "session-secret");
  await h.input("模型名", "org/my-model");
  assert.equal(h.inputType("LLM API Key（可选）"), "password");
  assert.equal(h.connect.props.disabled, false);
  assert.doesNotMatch(h.text, /model registry unavailable/);
  await h.clickConnect();
  const request = h.requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(request.body), {
    project: "/project", resume: false,
    llm: { baseUrl: "http://gateway.test/v1", apiKey: "session-secret", model: "org/my-model" },
  });
  assert.equal(request.headers.Authorization, "Bearer backend-token");
  await h.reply(h.requests.indexOf(request), { id: "custom-session", modelLabel: "org/my-model", resumed: false });
  const ask = h.requests.find((request) => request.url.endsWith("/ask"));
  assert.ok(ask);
  assert.doesNotMatch(JSON.stringify(ask), /session-secret/);
});

test("custom mode requires a backend token and valid URL and model, but allows an empty API key", async (t) => {
  const h = await setup(t);
  await h.mode("custom");
  await h.input("项目路径 或 git URL", "/project");
  await h.input("LLM BaseURL", "http://localhost:11434/v1");
  await h.input("模型名", "local/model");
  assert.equal(h.connect.props.disabled, true);
  await h.input("Token", "backend-token");
  assert.equal(h.connect.props.disabled, false);
  await h.input("LLM BaseURL", "file:///tmp/model");
  assert.equal(h.connect.props.disabled, true);
  await h.input("LLM BaseURL", "http://localhost:11434/v1?api_key=secret");
  assert.equal(h.connect.props.disabled, true);
  assert.match(h.text, /查询参数/);
  await h.input("LLM BaseURL", "http://localhost:11434/v1");
  await h.input("模型名", "  ");
  assert.equal(h.connect.props.disabled, true);
  await h.input("模型名", "local/model");
  await h.clickConnect();
  const request = h.requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(request.body).llm, { baseUrl: "http://localhost:11434/v1", model: "local/model" });
});

test("switching back to a backend model never submits custom LLM credentials", async (t) => {
  const h = await setup(t);
  await h.input("项目路径 或 git URL", "/project");
  await h.input("Token", "backend-token");
  await h.flushTimers();
  await h.reply(0, modelList);
  await h.mode("custom");
  await h.input("LLM BaseURL", "http://gateway.test/v1");
  await h.input("LLM API Key（可选）", "custom-secret");
  await h.input("模型名", "org/custom");
  await h.mode("backend");
  assert.equal(h.connect.props.disabled, false);
  await h.clickConnect();
  const request = h.requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(request.body), { project: "/project", resume: false, modelId: "openai-codex/gpt-5-mini" });
  assert.doesNotMatch(request.body, /custom-secret|gateway/);
});


const histories = {
  projectPath: "/connected-project",
  sessions: [
    { id: "history-older", title: "分析 Raft 选举流程", createdAt: "2026-10-17T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z", messageCount: 8, modelLabel: "openai/gpt-example" },
    { id: "history-active", title: "正在使用的会话", createdAt: "2026-10-18T11:00:00.000Z", updatedAt: "2026-10-18T11:00:00.000Z", messageCount: 2, active: true, activeSessionId: "orphan-runtime" },
  ],
};

function historyRequest(h) { return h.requests.findLastIndex((request) => request.url.includes("/history?")); }

test("history is an explicit startup choice and loads only after selecting it", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.flushTimers();
  assert.equal(historyRequest(h), -1);
  await h.closeConfig();
  await h.openHistory();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.connect.props.disabled, true);
  await h.flushTimers();
  const index = historyRequest(h);
  assert.match(h.requests[index].url, /history\?project=%2Fconnected-project$/);
  assert.equal(h.requests[index].headers.Authorization, "Bearer backend-token");
  await h.reply(index, histories);
  assert.equal(h.historyOptions.length, 2);
  assert.match(h.visibleText, /分析 Raft 选举流程/);
  assert.match(h.visibleText, /8 条消息/);
  assert.match(h.visibleText, /openai\/gpt-example/);
  assert.match(h.visibleText, /使用中/);
  assert.equal(h.historyOptions.find((option) => option.props.value === "history-active").props.disabled, true);
  assert.equal(h.connect.props.disabled, true, "never automatically selects the newest history");
});

test("opening a selected historical session submits its ID and displays restored messages without a greeting", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), histories);
  await h.selectHistory("history-older");
  assert.equal(h.connect.props.disabled, false);
  assert.match(h.visibleText, /使用下方模型配置继续/);
  await h.clickConnect();
  const create = h.requests.findLastIndex((request) => request.method === "POST");
  assert.equal(JSON.parse(h.requests[create].body).historyId, "history-older");
  assert.equal(JSON.parse(h.requests[create].body).resume, false);
  await h.reply(create, {
    id: "restored-session", modelLabel: "org/custom-model", resumed: true,
    messages: [{ id: "old-question", role: "user", content: "历史问题", thinking: "", tools: [], streaming: false }, { id: "old-reply", role: "assistant", content: "历史回答", thinking: "", tools: [], streaming: false }],
  });
  assert.equal(h.dialogs.length, 0);
  assert.match(h.visibleText, /历史问题/);
  assert.match(h.visibleText, /历史回答/);
  assert.equal(h.requests.filter((request) => request.url.endsWith("/ask")).length, 0);
});

test("changing the project or backend token immediately invalidates selected history and ignores old results", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), histories);
  await h.selectHistory("history-older");
  assert.equal(h.connect.props.disabled, false);
  await h.input("项目路径 或 git URL", "/other-project");
  assert.equal(h.connect.props.disabled, true);
  assert.equal(h.historyOptions.length, 0);
  await h.flushTimers();
  const stale = historyRequest(h);
  await h.input("Token", "changed-token");
  assert.equal(h.historyOptions.length, 0);
  await h.flushTimers();
  await h.reply(historyRequest(h), { projectPath: "/other-project", sessions: [] });
  await h.reply(stale, histories);
  assert.equal(h.historyOptions.length, 0);
  assert.match(h.visibleText, /还没有历史会话/);
  assert.equal(h.connect.props.disabled, true);
});

test("history errors are visible, refresh clears errors, and returning to new mode needs no history selection", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), { error: "unauthorized" }, 401);
  assert.match(h.visibleText, /401/);
  assert.match(h.visibleText, /后端.*Token/);
  await h.refreshHistory();
  assert.doesNotMatch(h.visibleText, /401/);
  await h.flushTimers();
  await h.reply(historyRequest(h), { projectPath: "/connected-project", sessions: [] });
  assert.match(h.visibleText, /还没有历史会话/);
  await h.sessionMode("new");
  assert.equal(h.connect.props.disabled, false);
  await h.clickConnect();
  const request = h.requests.findLast((request) => request.method === "POST");
  assert.equal(JSON.parse(request.body).historyId, undefined);
  assert.equal(JSON.parse(request.body).resume, false);
});

test("reopening configuration refreshes historical session ownership while keeping model drafts", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), histories);
  await h.selectHistory("history-older");
  await h.clickConnect();
  const create = h.requests.findLastIndex((request) => request.method === "POST");
  await h.reply(create, { id: "restored-session", modelLabel: "org/custom-model", resumed: true, messages: [] });
  assert.equal(h.dialogs.length, 0);
  await h.openConfig();
  assert.equal(h.connect.props.disabled, true, "must not reuse a selected history that is now in use");
  assert.equal(h.historyOptions.length, 0);
  assert.equal(h.inputValue("LLM API Key（可选）"), "session-secret");
  assert.equal(h.inputValue("模型名"), "org/custom-model");
  await h.flushTimers();
  await h.reply(historyRequest(h), { ...histories, sessions: histories.sessions.map((session) => ({ ...session, active: true })) });
  assert.equal(h.historyOptions.every((option) => option.props.disabled), true);
  assert.equal(h.connect.props.disabled, true);
});

test("an occupied history can be explicitly released, then selected again without losing its record", async (t) => {
  const h = await setup(t, { autoRelease: false });
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), histories);
  await h.clickButton("退出会话");
  assert.match(h.visibleText, /中止.*回复/);
  assert.match(h.visibleText, /保留历史/);
  assert.equal(h.requests.filter((r) => r.method === "DELETE").length, 0);
  await h.clickButton("取消");
  assert.equal(h.requests.filter((r) => r.method === "DELETE").length, 0);
  await h.clickButton("退出会话");
  await h.clickButton("确认退出");
  const index = h.requests.findLastIndex((r) => r.method === "DELETE");
  assert.equal(h.requests[index].url, "http://127.0.0.1:8787/sessions/orphan-runtime");
  assert.equal(h.requests[index].headers.Authorization, "Bearer backend-token");
  assert.equal(h.connect.props.disabled, true);
  await h.reply(index, { ok: true });
  await h.flushTimers();
  await h.reply(historyRequest(h), { ...histories, sessions: histories.sessions.map((s) => ({ ...s, active: false, activeSessionId: undefined })) });
  assert.equal(h.historyOptions.find((o) => o.props.value === "history-active").props.disabled, false);
  await h.selectHistory("history-active");
  assert.equal(h.connect.props.disabled, false);
  assert.match(h.visibleText, /正在使用的会话/);
});

test("failed history release keeps its confirmation and occupancy visible and allows retry", async (t) => {
  const h = await setup(t, { autoRelease: false });
  await configureCustomSession(h);
  await h.sessionMode("history");
  await h.flushTimers();
  await h.reply(historyRequest(h), histories);
  await h.clickButton("退出会话");
  await h.clickButton("确认退出");
  await h.reply(h.requests.findLastIndex((r) => r.method === "DELETE"), { error: "unauthorized" }, 401);
  assert.match(h.visibleText, /401.*Token/);
  assert.equal(h.historyOptions.find((o) => o.props.value === "history-active").props.disabled, true);
  await h.clickButton("确认退出");
  assert.equal(h.requests.filter((r) => r.method === "DELETE").length, 2);
  await h.reply(h.requests.findLastIndex((r) => r.method === "DELETE"), { ok: true });
});


test("Skills management binds to actual session project and original backend even while configuration drafts change", async (t) => {
  const h = await setup(t);
  await configureCustomSession(h, "https://git.test/team/project.git");
  await h.clickConnect();
  const creation = h.requests.findLastIndex((request) => request.url.endsWith("/sessions"));
  await h.reply(creation, { id: "bound-session", projectPath: "/canonical/cloned-project", modelLabel: "actual", resumed: true, skillsRevision: 7, skills: [] });
  await h.openConfig();
  await h.input("后端地址", "http://draft-backend.test");
  await h.input("Token", "draft-token");
  await h.input("项目路径 或 git URL", "/draft-project");
  await h.closeConfig();
  await h.openSkills();
  const first = h.requests.findLastIndex((request) => request.url.includes("/skills?"));
  assert.equal(h.requests[first].url, "http://127.0.0.1:8787/skills?project=%2Fcanonical%2Fcloned-project");
  assert.equal(h.requests[first].headers.Authorization, "Bearer backend-token");
  await h.reply(first, { projectPath: "/canonical/cloned-project", revision: 7, installed: [], local: [] });
  assert.match(h.visibleText, /当前会话项目：\/canonical\/cloned-project/);
  assert.match(h.visibleText, /当前会话已应用 0 个技能 · 修订 7/);
  await h.closeSkills();
  await h.newSession();
  await h.closeConfig();
  await h.openSkills();
  const second = h.requests.findLastIndex((request) => request.url.includes("/skills?"));
  assert.equal(h.requests[second].url, "http://draft-backend.test/skills?project=%2Fdraft-project");
  assert.equal(h.requests[second].headers.Authorization, "Bearer draft-token");
  await h.reply(second, { projectPath: "/draft-project", revision: 0, installed: [], local: [] });
  assert.match(h.visibleText, /待连接项目：\/draft-project/);
});
