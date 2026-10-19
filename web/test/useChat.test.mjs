import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { useChat } from "../src/hooks/useChat.ts";

const config = { baseUrl: "http://first.test", token: "first-token" };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function setup(t, sessionResponse = {}) {
  const sessions = new Set();
  const requests = [];
  const streams = [];
  const pendingCreates = [];
  let delayCreates = false;
  let nextId = 0;
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "DELETE") {
      const id = url.split("/").at(-1);
      return Response.json({ ok: sessions.delete(id) });
    }
    if (url.endsWith("/sessions")) {
      const info = { id: `session-${++nextId}`, projectPath: "/project", modelLabel: "Test model", resumed: false, ...sessionResponse };
      sessions.add(info.id);
      if (delayCreates) {
        const response = deferred();
        pendingCreates.push({ info, finish: () => response.resolve(Response.json(info)) });
        return response.promise;
      }
      return Response.json(info);
    }
    if (url.endsWith("/ask")) {
      let controller;
      let closed = false;
      const body = new ReadableStream({ start(value) { controller = value; } });
      // Deliberately allow already queued events to arrive after abort. This
      // exercises hook ownership rather than relying on transport cancellation.
      streams.push({
        signal: options.signal,
        event(name, data) {
          controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        },
        close() { if (!closed) { closed = true; controller.close(); } },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  t.mock.method(globalThis, "fetch", fetch);
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const lifecycle = new EventTarget();
  globalThis.window = { fetch, setTimeout, clearTimeout,
    addEventListener: lifecycle.addEventListener.bind(lifecycle),
    removeEventListener: lifecycle.removeEventListener.bind(lifecycle),
  };
  globalThis.document = { removeEventListener() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // React 19 deprecates this renderer; retain all other warnings/errors.
  const originalError = console.error;
  t.mock.method(console, "error", (...args) => {
    if (String(args[0]).startsWith("react-test-renderer is deprecated")) return;
    originalError(...args);
  });

  let chat;
  function Harness({ serverConfig }) {
    chat = useChat(serverConfig);
    return null;
  }
  let root;
  await act(async () => { root = create(React.createElement(Harness, { serverConfig: config })); });
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => { root.unmount(); });
  };
  t.after(async () => {
    await unmount();
    await act(async () => { streams.forEach((stream) => stream.close()); await nextTick(); });
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldActEnvironment;
  });
  return {
    get chat() { return chat; }, sessions, requests, streams, pendingCreates, unmount,
    async pageEvent(type, persisted = false) {
      const event = new Event(type);
      Object.defineProperty(event, "persisted", { value: persisted });
      await act(async () => { lifecycle.dispatchEvent(event); await nextTick(); });
    },
    delayCreates() { delayCreates = true; },
    async render(serverConfig) {
      await act(async () => { root.update(React.createElement(Harness, { serverConfig })); });
    },
    async connect() { await act(async () => { await chat.connect("/project", false); }); },
    async start() { await act(async () => { void chat.send("First user question"); }); },
    async finish(index, answer) {
      await act(async () => {
        streams[index].event("done", { answer });
        streams[index].close();
        await nextTick();
      });
    },
  };
}

test("new session deletes the previous server session and aborts its stream", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await act(async () => { h.chat.newSession(); });
  assert.equal(h.sessions.size, 0);
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.chat.sessionId, null);
  assert.deepEqual(h.chat.messages, []);
  assert.equal(h.chat.streaming, false);
});

test("reconnecting releases the previous session", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await h.connect();
  assert.deepEqual([...h.sessions], ["session-2"]);
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.chat.sessionId, "session-2");
});

test("a late session response after reset is released and cannot reconnect the UI", async (t) => {
  const h = await setup(t, { resumed: true, messages: [{ id: "old", role: "user", content: "old conversation", thinking: "", tools: [], streaming: false }] });
  h.delayCreates();
  let connecting;
  await act(async () => { connecting = h.chat.connect("/project", false); });
  await act(async () => { h.chat.newSession(); });
  await act(async () => { h.pendingCreates[0].finish(); await connecting; });
  assert.equal(h.sessions.size, 0);
  assert.equal(h.chat.sessionId, null);
  assert.deepEqual(h.chat.messages, []);
  assert.equal(h.streams.length, 0);
});

test("restoring a selected history displays its transcript without requesting a greeting or summary", async (t) => {
  const transcript = [
    { id: "saved-user", role: "user", content: "Explain the queue", thinking: "", tools: [], streaming: false },
    { id: "saved-assistant", role: "assistant", content: "The queue is serial", thinking: "Read the implementation", tools: [{ name: "read", isError: false }], stopped: true, streaming: false },
  ];
  const h = await setup(t, { resumed: true, historyId: "saved-history", messages: transcript });
  await act(async () => { await h.chat.connect("/project", false, "provider/model", "saved-history"); });
  const request = h.requests.find((request) => request.url.endsWith("/sessions") && request.method === "POST");
  assert.equal(JSON.parse(request.body).historyId, "saved-history");
  assert.deepEqual(h.chat.messages, transcript);
  assert.equal(h.chat.streaming, false);
  assert.equal(h.streams.length, 0);
  let question;
  await act(async () => { question = h.chat.send("Continue explaining"); });
  await h.finish(0, "The next detail");
  await question;
  assert.deepEqual(h.chat.messages.slice(0, 2), transcript);
  assert.equal(h.chat.messages.at(-1).content, "The next detail");
});

test("only the latest overlapping connection can become active", async (t) => {
  const h = await setup(t);
  h.delayCreates();
  let first;
  let second;
  await act(async () => {
    first = h.chat.connect("/first", false);
    second = h.chat.connect("/second", false);
  });
  await act(async () => { h.pendingCreates[1].finish(); await second; });
  await act(async () => { h.pendingCreates[0].finish(); await first; });
  assert.equal(h.chat.sessionId, "session-2");
  assert.deepEqual([...h.sessions], ["session-2"]);
  assert.equal(h.streams.length, 0);
});

test("stopping before the first reply marks the message stopped and aborts the request", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await act(async () => { h.chat.stop(); });
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.chat.streaming, false);
  assert.equal(h.chat.messages[2].streaming, false);
  assert.equal(h.chat.messages[2].stopped, true);
  assert.equal(h.chat.messages[2].content, "");
  assert.equal(h.chat.messages[2].error, undefined);
});

test("stopped stream completion and late events cannot alter a replacement stream", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await act(async () => {
    h.streams[0].event("text", { delta: "partial answer" });
    h.streams[0].event("thinking", { delta: "partial thinking" });
    h.streams[0].event("tool", { name: "read", args: { path: "index.ts" }, phase: "start" });
    await nextTick();
  });
  let question;
  await act(async () => {
    h.chat.stop();
    question = h.chat.send("new question");
    await nextTick();
  });
  assert.equal(h.chat.streaming, true);
  assert.equal(h.streams[0].signal.aborted, true);
  await act(async () => {
    h.streams[0].event("text", { delta: "stale answer" });
    h.streams[0].event("thinking", { delta: "stale thinking" });
    h.streams[0].event("tool", { name: "read", phase: "end", isError: false });
    h.streams[0].event("done", { answer: "stale final answer" });
    h.streams[0].event("error", { message: "stale error" });
    h.streams[0].close();
    h.streams[1].event("text", { delta: "current answer" });
    await nextTick();
  });
  assert.equal(h.chat.streaming, true);
  assert.equal(h.chat.messages.at(-1).streaming, true);
  await h.finish(1, "current answer");
  await question;
  assert.equal(h.chat.messages.at(-1).content, "current answer");
  assert.equal(h.chat.messages.at(-1).error, undefined);
  assert.equal(h.chat.messages.at(-1).streaming, false);
  assert.notEqual(h.chat.messages.at(-1).stopped, true);
  assert.equal(h.chat.messages[2].content, "partial answer");
  assert.equal(h.chat.messages[2].thinking, "partial thinking");
  assert.deepEqual(h.chat.messages[2].tools, [{ name: "read", args: { path: "index.ts" } }]);
  assert.equal(h.chat.messages[2].error, undefined);
  assert.equal(h.chat.messages[2].streaming, false);
  assert.equal(h.chat.messages[2].stopped, true);
});

test("questions and cleanup use the configuration that created the session", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.render({ baseUrl: "http://second.test", token: "second-token" });
  let question;
  await act(async () => { question = h.chat.send("where is the code?"); });
  await h.finish(0, "here");
  await question;
  await act(async () => { h.chat.newSession(); });
  const questionRequest = h.requests.filter((request) => request.url.endsWith("/ask"))[0];
  const deletion = h.requests.find((request) => request.method === "DELETE");
  assert.equal(questionRequest.url, "http://first.test/sessions/session-1/ask");
  assert.equal(questionRequest.headers.Authorization, "Bearer first-token");
  assert.equal(deletion.url, "http://first.test/sessions/session-1");
  assert.equal(deletion.headers.Authorization, "Bearer first-token");
});

test("unmount releases the active server session", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await h.unmount();
  assert.equal(h.sessions.size, 0);
  assert.equal(h.streams[0].signal.aborted, true);
});

test("page refresh releases its backend session with original authentication and aborts the stream", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await h.render({ baseUrl: "http://edited.test", token: "edited-token" });
  await h.pageEvent("pagehide");
  assert.equal(h.sessions.size, 0, "refresh must release the historical session's active lock");
  assert.equal(h.streams[0].signal.aborted, true);
  const deletion = h.requests.find((request) => request.method === "DELETE");
  assert.equal(deletion.url, "http://first.test/sessions/session-1");
  assert.equal(deletion.headers.Authorization, "Bearer first-token");
  assert.equal(deletion.keepalive, true);
  await h.unmount();
  assert.equal(h.requests.filter((request) => request.method === "DELETE").length, 1);
});

test("returning from the back-forward cache clears the released connection and late creation cannot reconnect", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.pageEvent("pagehide", true);
  await h.pageEvent("pageshow", true);
  assert.equal(h.chat.sessionId, null);
  assert.deepEqual(h.chat.messages, []);
  h.delayCreates();
  let connecting;
  await act(async () => { connecting = h.chat.connect("/project", false); });
  await h.pageEvent("pagehide");
  await act(async () => { h.pendingCreates[0].finish(); await connecting; });
  assert.equal(h.sessions.size, 0);
  assert.equal(h.chat.sessionId, null);
});

test("manual disconnect affects only the exact backend session and clears its current UI", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.start();
  await act(async () => { await h.chat.disconnect("session-1", { baseUrl: "http://other.test", token: "other-token" }); });
  assert.equal(h.chat.sessionId, "session-1", "an equal ID on another backend is not the current session");
  assert.equal(h.streams[0].signal.aborted, false);
  await act(async () => { await h.chat.disconnect("another-session", config); });
  assert.equal(h.chat.sessionId, "session-1");
  await act(async () => { await h.chat.disconnect("session-1", config); });
  assert.equal(h.chat.sessionId, null);
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.requests.filter((request) => request.method === "DELETE").length, 3, "a confirmed release must not send a duplicate delete");
});

test("a delayed manual release cannot clear a replacement session and failed release keeps its connection", async (t) => {
  const h = await setup(t);
  await h.connect();
  const fetch = globalThis.fetch;
  const delayed = deferred();
  t.mock.method(globalThis, "fetch", (url, options) => options?.method === "DELETE"
    ? delayed.promise : fetch(url, options));
  let releasing;
  await act(async () => { releasing = h.chat.disconnect("session-1", config); });
  await h.connect();
  assert.equal(h.chat.sessionId, "session-2");
  await act(async () => { delayed.resolve(Response.json({ ok: true })); await releasing; });
  assert.equal(h.chat.sessionId, "session-2");
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  await act(async () => { await assert.rejects(() => h.chat.disconnect("session-2", config), /401/); });
  assert.equal(h.chat.sessionId, "session-2");
  // Let normal teardown release this synthetic session without logging failures.
  t.mock.method(globalThis, "fetch", fetch);
});

const skillPreview = {
  id: "preview-1", projectPath: "/canonical/project", expiresAt: "2099-01-01T00:00:00.000Z", warnings: [],
  skill: { id: "skill-1", name: "review", description: "Review code", version: "hash-1", source: { kind: "url", label: "https://skills.test/SKILL.md" }, disableModelInvocation: false, files: [{ path: "SKILL.md", size: 55 }] },
};

test("skill events track the actual session project, ignore another project and retain confirmation cards after completion", async (t) => {
  const h = await setup(t, { projectPath: "/canonical/project", skillsRevision: 2, skills: [] });
  await h.connect();
  await h.start();
  assert.equal(h.chat.projectPath, "/canonical/project");
  assert.deepEqual(h.chat.activeConfig, config);
  assert.equal(h.chat.skillsRevision, 2);
  await act(async () => {
    h.streams[0].event("skill_preview", { ...skillPreview, id: "wrong", projectPath: "/other" });
    h.streams[0].event("skill_preview", skillPreview);
    h.streams[0].event("skills_applied", { projectPath: "/canonical/project", revision: 3, skills: [skillPreview.skill] });
    h.streams[0].event("skills_applied", { projectPath: "/other", revision: 99, skills: [] });
    await nextTick();
  });
  await h.finish(0, "Please confirm");
  assert.equal(h.chat.skillsRevision, 3);
  assert.equal(h.chat.skills.length, 1);
  assert.deepEqual(h.chat.messages[2].skillPreviews, [skillPreview]);
  await act(async () => { h.chat.newSession(); });
  assert.equal(h.chat.projectPath, null);
  assert.equal(h.chat.activeConfig, null);
  assert.deepEqual(h.chat.skills, []);
  assert.equal(h.chat.skillsRevision, 0);
});

test("conversation confirmation uses its original backend and a late confirmation cannot attach to a replacement session", async (t) => {
  const h = await setup(t, { projectPath: "/canonical/project", resumed: true });
  await h.connect();
  let question;
  await act(async () => { question = h.chat.send("import https://skills.test/SKILL.md"); });
  await act(async () => { h.streams[0].event("skill_preview", skillPreview); await nextTick(); });
  await h.finish(0, "Review this preview");
  await question;
  await h.render({ baseUrl: "http://draft.test", token: "draft-token" });
  const originalFetch = globalThis.fetch;
  const confirmation = deferred();
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (!url.includes("/confirm")) return originalFetch(url, options);
    requests.push({ url, ...options });
    return confirmation.promise;
  });
  let confirming;
  await act(async () => { confirming = h.chat.confirmSkillPreview(skillPreview); });
  assert.equal(requests[0].url, "http://first.test/skills/imports/preview-1/confirm");
  assert.equal(requests[0].headers.Authorization, "Bearer first-token");
  await h.connect();
  await act(async () => {
    confirmation.resolve(Response.json({ previewId: skillPreview.id, installed: skillPreview.skill, snapshot: { projectPath: "/canonical/project", revision: 5, skills: [skillPreview.skill] } }));
    await confirming;
  });
  assert.equal(h.chat.sessionId, "session-2");
  assert.deepEqual(h.chat.messages, []);
  assert.equal(h.chat.skillsRevision, 0, "confirmation is pending for the next question; applied metadata comes from runtime events");
  await assert.rejects(() => h.chat.confirmSkillPreview(skillPreview), /不属于当前会话/);
  assert.equal(requests.length, 1);
});

test("successful conversation confirmation preserves the preview and records confirmed status without inventing applied revision", async (t) => {
  const h = await setup(t, { projectPath: "/canonical/project" });
  await h.connect();
  await h.start();
  await act(async () => { h.streams[0].event("skill_preview", skillPreview); await nextTick(); });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => url.includes("/confirm")
    ? Promise.resolve(Response.json({ previewId: skillPreview.id, installed: skillPreview.skill, snapshot: { projectPath: "/canonical/project", revision: 8, skills: [skillPreview.skill] } }))
    : originalFetch(url, options));
  await act(async () => { await h.chat.confirmSkillPreview(skillPreview); });
  await h.finish(0, "ready");
  assert.deepEqual(h.chat.messages[2].confirmedSkillPreviews, [skillPreview.id]);
  assert.equal(h.chat.skillsRevision, 0);
});

test("fresh sessions show a local welcome without consuming a model turn", async (t) => {
  const h = await setup(t);
  await h.connect();
  assert.equal(h.streams.length, 0);
  assert.equal(h.chat.streaming, false);
  assert.equal(h.chat.messages.length, 1);
  assert.equal(h.chat.messages[0].role, "assistant");
  assert.match(h.chat.messages[0].content, /代码/);
  assert.equal(h.chat.messages[0].answerId, undefined);
});

test("done preserves backend answer identity and a stable request id with bypass", async (t) => {
  const h = await setup(t, { resumed: true });
  await h.connect();
  let question;
  await act(async () => { question = h.chat.send("Question", "bypass"); });
  const request = h.requests.find((item) => item.url.endsWith("/ask"));
  assert.match(JSON.parse(request.body).requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(request.body).reuse, "bypass");
  const metadata = { answerId: "server-answer", answerVersion: "v1", source: "exact", knowledgeIds: ["k1"], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, quality: "no-model-call" } };
  await act(async () => { h.streams[0].event("done", { answer: "Canonical", ...metadata }); h.streams[0].close(); await nextTick(); });
  await question;
  assert.equal(h.chat.messages.at(-1).content, "Canonical");
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(h.chat.messages.at(-1)[key], value);
});

test("stale context blocks later asks and starts fresh on the active backend without carrying answers", async (t) => {
  const h = await setup(t, { resumed: true });
  await h.connect();
  let question;
  await act(async () => { question = h.chat.send("Question"); });
  await act(async () => { h.streams[0].event("error", { message: "Code changed", code: "context_stale" }); h.streams[0].close(); await nextTick(); });
  await question;
  assert.equal(h.chat.contextStale, true);
  await act(async () => { await h.chat.send("Cannot continue"); });
  assert.equal(h.streams.length, 1);
  assert.match(h.chat.messages.at(-1).error, /Code changed/);
  await h.render({ baseUrl: "http://draft.test", token: "draft" });
  await act(async () => { await h.chat.restartSession(); });
  const creates = h.requests.filter((item) => item.url.endsWith("/sessions"));
  assert.equal(creates.at(-1).url, "http://first.test/sessions");
  assert.equal(creates.at(-1).headers.Authorization, "Bearer first-token");
  assert.equal(JSON.parse(creates.at(-1).body).project, "/project");
  assert.equal(h.chat.contextStale, false);
  assert.equal(h.chat.messages.some((item) => item.content === "Question"), false);
});
