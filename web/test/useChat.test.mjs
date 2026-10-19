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

test('follow-ups keep separate streams and enter history only when started', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  assert.equal(typeof h.chat.followUp, 'function');
  let accepted;
  await act(async () => { accepted = h.chat.followUp('Next question', 'bypass'); });
  const request = JSON.parse(h.requests.filter(r => r.url.endsWith('/ask'))[1].body);
  assert.equal(request.mode, 'followUp');
  const pending = {id: request.requestId, question: 'Next question', mode: 'followUp', createdAt: 1, status: 'pending', reuse: 'bypass'};
  await act(async () => { h.streams[1].event('queue', {revision: 2, activeRequestId: 'first', pending: [pending]}); await nextTick(); await accepted; });
  assert.equal(h.chat.messages.length, 2);
  assert.deepEqual(h.chat.pendingMessages, [pending]);
  assert.equal(h.streams[0].signal.aborted, false);
  await act(async () => { h.chat.stop(); });
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.streams[1].signal.aborted, false);
  await act(async () => {
    h.streams[1].event('started', {requestId: request.requestId, question: 'Next question'});
    h.streams[1].event('queue', {revision: 3, activeRequestId: request.requestId, pending: []});
    await nextTick();
  });
  assert.equal(h.chat.messages.at(-2).content, 'Next question');
  assert.equal(h.chat.streaming, true);
  await h.finish(1, 'Next answer');
  assert.equal(h.chat.messages.at(-1).content, 'Next answer');
  assert.equal(h.chat.streaming, false);
});

test('steering splits partial replies and keeps answer identity on the final segment', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  const requestId = JSON.parse(h.requests.find(r => r.url.endsWith('/ask')).body).requestId;
  await act(async () => {
    h.streams[0].event('text', {delta: 'Before correction'});
    h.streams[0].event('steering_applied', {requestId: 'correction', question: 'Focus on errors', targetRequestId: requestId});
    h.streams[0].event('text', {delta: 'After correction'});
    h.streams[0].event('done', {answer: 'After correction', answerId: 'final-answer'});
    h.streams[0].close(); await nextTick();
  });
  assert.deepEqual(h.chat.messages.map(m => m.content), ['First user question', 'Before correction', 'Focus on errors', 'After correction']);
  assert.equal(h.chat.messages[1].streaming, false);
  assert.equal(h.chat.messages[1].answerId, undefined);
  assert.equal(h.chat.messages[3].answerId, 'final-answer');
});

test('queue revisions and abandoned sessions cannot resurrect pending cards', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  const pending = {id: 'pending', question: 'Next', mode: 'followUp', createdAt: 1, status: 'pending'};
  await act(async () => {
    h.streams[0].event('queue', {revision: 4, activeRequestId: 'active', pending: [pending]});
    h.streams[0].event('queue', {revision: 3, activeRequestId: 'active', pending: []}); await nextTick();
  });
  assert.deepEqual(h.chat.pendingMessages, [pending]);
  await h.connect();
  await act(async () => { h.streams[0].event('queue', {revision: 99, activeRequestId: 'old', pending: [pending]}); await nextTick(); });
  assert.deepEqual(h.chat.pendingMessages, []);
});

test('stopping reconciles pending steering without a live stream and stops polling after unapplied', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  const pending = {id: 'steer', question: 'Correction', mode: 'steer', targetRequestId: h.chat.activeRequestId, createdAt: 1, status: 'pending'};
  const originalFetch = globalThis.fetch;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.endsWith('/messages')) {reads++; return Promise.resolve(Response.json({revision: 5, activeRequestId: null, pending: [{...pending, status: 'unapplied'}]}));}
    return originalFetch(url, options);
  });
  await act(async () => {h.streams[0].event('queue', {revision: 4, activeRequestId: h.chat.activeRequestId, pending: [pending]}); await nextTick();});
  t.mock.timers.enable({apis: ['setTimeout']});
  t.mock.method(window, 'setTimeout', globalThis.setTimeout);
  t.mock.method(window, 'clearTimeout', globalThis.clearTimeout);
  await act(async () => {h.chat.stop();});
  await act(async () => {t.mock.timers.tick(1000); await nextTick();});
  assert.equal(reads, 1);
  assert.equal(h.chat.pendingMessages[0].status, 'unapplied');
  await act(async () => {t.mock.timers.tick(5000); await nextTick();});
  assert.equal(reads, 1);
  t.mock.timers.reset();
});

test('steer binds active identity, cancellation waits and old responses cannot refill a new session', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  const active = h.chat.activeRequestId;
  const originalFetch = globalThis.fetch;
  let pending;
  const removed = deferred();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/steer')) {
      const body = JSON.parse(options.body); assert.equal(body.targetRequestId, active);
      pending = {id: body.requestId, question: body.question, mode: 'steer', targetRequestId: active, createdAt: 1, status: 'pending'};
      return Response.json({message: pending, state: {revision: 2, activeRequestId: active, pending: [pending]}});
    }
    if (url.includes('/messages/')) return removed.promise;
    return originalFetch(url, options);
  });
  await act(async () => {await h.chat.steer('Correction');});
  assert.deepEqual(h.chat.pendingMessages, [pending]);
  assert.equal(h.chat.messages.length, 2);
  let cancelling;
  await act(async () => {cancelling = h.chat.cancelPending(pending.id).then(() => 'success', error => error.message);});
  assert.equal(h.chat.pendingMessages.length, 1);
  await h.connect();
  await act(async () => {removed.resolve(Response.json({message: pending, state: {revision: 3, activeRequestId: active, pending: []}}));});
  assert.match(await cancelling, /会话已切换/);
  assert.deepEqual(h.chat.pendingMessages, []);
});

test('unrelated initial queue state does not accept a rejected follow-up or clear its draft', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let result = 'pending';
  let submission;
  await act(async () => { submission = h.chat.followUp('Invalid next').then(() => {result = 'accepted';}, error => {result = error.message;}); });
  await act(async () => {h.streams[1].event('queue', {revision: 1, activeRequestId: h.chat.activeRequestId, pending: []}); await nextTick();});
  assert.equal(result, 'pending');
  await act(async () => {h.streams[1].event('error', {message: 'Cannot queue question'}); h.streams[1].close(); await nextTick(); await submission;});
  assert.equal(result, 'Cannot queue question');
  assert.equal(h.chat.messages.length, 2);
});

test('sending after stop joins outstanding follow-ups and respects their started order', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let secondAccepted;
  await act(async () => {secondAccepted = h.chat.followUp('Second question');});
  const second = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask'))[1].body);
  const pending = {id: second.requestId, question: 'Second question', mode: 'followUp', createdAt: 1, status: 'pending'};
  await act(async () => {h.streams[1].event('queue', {revision: 2, activeRequestId: h.chat.activeRequestId, pending: [pending]}); await nextTick(); await secondAccepted;});
  await act(async () => {h.chat.stop();});
  assert.equal(h.chat.streaming, false);
  let thirdAccepted;
  await act(async () => {thirdAccepted = h.chat.send('Third question');});
  const third = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask'))[2].body);
  assert.equal(third.mode, 'followUp');
  assert.deepEqual(h.chat.messages.map(message => message.content), ['First user question', '']);
  await act(async () => {
    h.streams[1].event('started', {requestId: second.requestId, question: 'Second question'});
    h.streams[1].event('text', {delta: 'Second partial'}); await nextTick();
  });
  assert.equal(h.chat.activeRequestId, second.requestId);
  await h.finish(1, 'Second answer');
  await act(async () => {
    h.streams[2].event('started', {requestId: third.requestId, question: 'Third question'});
    h.streams[2].event('text', {delta: 'Third partial'}); await nextTick(); await thirdAccepted;
  });
  assert.equal(h.chat.activeRequestId, third.requestId);
  await h.finish(2, 'Third answer');
  assert.deepEqual(h.chat.messages.map(message => message.content), ['First user question', '', 'Second question', 'Second answer', 'Third question', 'Third answer']);
});

test('late done finalizes its own canonical answer and identity after the next stream starts', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let accepted;
  await act(async () => {accepted = h.chat.followUp('Next question');});
  const next = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask'))[1].body);
  await act(async () => {
    h.streams[0].event('text', {delta: 'First partial'}); await nextTick();
    h.streams[1].event('started', {requestId: next.requestId, question: 'Next question'});
    h.streams[1].event('text', {delta: 'Next partial'}); await nextTick(); await accepted;
    h.streams[0].event('done', {answer: 'First canonical', answerId: 'first-answer', answerVersion: 'v1', source: 'model'}); await nextTick();
  });
  assert.equal(h.chat.messages[1].content, 'First canonical');
  assert.equal(h.chat.messages[1].answerId, 'first-answer');
  assert.equal(h.chat.messages[1].answerVersion, 'v1');
  assert.equal(h.chat.messages[1].streaming, false);
  assert.equal(h.chat.activeRequestId, next.requestId);
  assert.equal(h.chat.streaming, true);
  await act(async () => {h.streams[0].close(); await nextTick();});
  assert.equal(h.chat.streaming, true);
  await act(async () => {h.streams[1].event('done', {answer: 'Next canonical', answerId: 'next-answer'}); h.streams[1].close(); await nextTick();});
  assert.equal(h.chat.messages[1].answerId, 'first-answer');
  assert.equal(h.chat.messages[3].content, 'Next canonical');
  assert.equal(h.chat.messages[3].answerId, 'next-answer');
});

test('late error belongs to the previous reply while the next stream keeps running', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let accepted;
  await act(async () => {accepted = h.chat.followUp('Next question');});
  const next = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask'))[1].body);
  await act(async () => {
    h.streams[1].event('started', {requestId: next.requestId, question: 'Next question'}); await nextTick(); await accepted;
    h.streams[0].event('error', {message: 'First failed'}); await nextTick();
  });
  assert.equal(h.chat.messages[1].error, 'First failed');
  assert.equal(h.chat.messages[1].streaming, false);
  assert.equal(h.chat.messages[3].error, undefined);
  assert.equal(h.chat.activeRequestId, next.requestId);
  assert.equal(h.chat.streaming, true);
  await act(async () => {h.streams[0].close(); await nextTick();});
  assert.equal(h.chat.streaming, true);
  await h.finish(1, 'Next answer');
  assert.equal(h.chat.messages[3].content, 'Next answer');
});

test('a wholly delayed earlier queued stream stays before the newer active stream without taking ownership', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let bAccepted, cAccepted;
  await act(async () => {bAccepted = h.chat.followUp('B question'); cAccepted = h.chat.followUp('C question');});
  const asks = h.requests.filter(request => request.url.endsWith('/ask')).map(request => JSON.parse(request.body));
  await h.finish(0, 'A answer');
  await act(async () => {
    h.streams[2].event('started', {requestId: asks[2].requestId, question: 'C question', revision: 8});
    h.streams[2].event('text', {delta: 'C partial'}); await nextTick(); await cAccepted;
    h.streams[1].event('queue', {revision: 5, activeRequestId: asks[1].requestId, pending: [{id: asks[2].requestId, question: 'C question', mode: 'followUp', createdAt: 1, status: 'pending'}]});
    h.streams[1].event('started', {requestId: asks[1].requestId, question: 'B question', revision: 6});
    h.streams[1].event('thinking', {delta: 'B thinking'});
    h.streams[1].event('tool', {name: 'read', phase: 'start'});
    h.streams[1].event('tool', {name: 'read', phase: 'end', isError: false});
    h.streams[1].event('text', {delta: 'B partial'});
    h.streams[1].event('done', {answer: 'B canonical', answerId: 'B-answer'});
    h.streams[1].close(); await nextTick(); await bAccepted;
  });
  assert.deepEqual(h.chat.messages.map(message => message.content).slice(0, 5), ['First user question', 'A answer', 'B question', 'B canonical', 'C question']);
  assert.equal(h.chat.messages[3].thinking, 'B thinking');
  assert.deepEqual(h.chat.messages[3].tools, [{name: 'read', args: undefined, isError: false}]);
  assert.equal(h.chat.messages[3].answerId, 'B-answer');
  assert.equal(h.chat.messages[3].streaming, false);
  assert.equal(h.chat.activeRequestId, asks[2].requestId);
  assert.equal(h.chat.streaming, true);
  const originalFetch = globalThis.fetch;
  let steeringTarget;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!url.endsWith('/steer')) return originalFetch(url, options);
    const input = JSON.parse(options.body);
    steeringTarget = input.targetRequestId;
    const message = {id: input.requestId, question: input.question, mode: 'steer', targetRequestId: input.targetRequestId, createdAt: 1, status: 'pending'};
    return Promise.resolve(Response.json({message, state: {revision: 9, activeRequestId: asks[2].requestId, pending: [message]}}));
  });
  await act(async () => {await h.chat.steer('C correction');});
  assert.equal(steeringTarget, asks[2].requestId);
  await act(async () => {h.chat.stop();});
  assert.equal(h.streams[2].signal.aborted, true);
  assert.equal(h.chat.messages.at(-1).stopped, true);
});

test('an earlier started revision cannot revive active controls after the newer request completes', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  let bAccepted, cAccepted;
  await act(async () => {bAccepted = h.chat.followUp('B question'); cAccepted = h.chat.followUp('C question');});
  const asks = h.requests.filter(request => request.url.endsWith('/ask')).map(request => JSON.parse(request.body));
  await h.finish(0, 'A answer');
  await act(async () => {h.streams[2].event('started', {requestId: asks[2].requestId, question: 'C question', revision: 8}); await nextTick(); await cAccepted;});
  await act(async () => {h.streams[2].event('done', {answer: 'C canonical', answerId: 'C-answer'}); h.streams[2].close(); await nextTick();});
  await act(async () => {
    h.streams[1].event('started', {requestId: asks[1].requestId, question: 'B question', revision: 6});
    h.streams[1].event('text', {delta: 'B partial'}); await nextTick(); await bAccepted;
  });
  assert.equal(h.chat.activeRequestId, null);
  assert.equal(h.chat.streaming, false);
  await act(async () => {h.streams[1].event('done', {answer: 'B canonical', answerId: 'B-answer'}); h.streams[1].close(); await nextTick();});
  assert.deepEqual(h.chat.messages.map(message => message.content), ['First user question', 'A answer', 'B question', 'B canonical', 'C question', 'C canonical']);
  assert.equal(h.chat.messages[3].answerId, 'B-answer');
  assert.equal(h.chat.messages[5].answerId, 'C-answer');
});

test('late steering and following deltas stay inside the original request group before its successor', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect(); await h.start();
  const first = h.chat.activeRequestId;
  let accepted;
  await act(async () => {accepted = h.chat.followUp('B question');});
  const next = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask'))[1].body);
  await act(async () => {
    h.streams[0].event('started', {requestId: first, question: 'First user question', revision: 2});
    h.streams[0].event('text', {delta: 'A before correction'}); await nextTick();
    h.streams[1].event('started', {requestId: next.requestId, question: 'B question', revision: 6}); await nextTick(); await accepted;
    h.streams[0].event('steering_applied', {requestId: 'correction', question: 'A correction', targetRequestId: first});
    h.streams[0].event('thinking', {delta: 'A corrected thinking'});
    h.streams[0].event('text', {delta: 'A corrected partial'});
    h.streams[0].event('done', {answer: 'A corrected canonical', answerId: 'A-final'}); h.streams[0].close(); await nextTick();
  });
  assert.deepEqual(h.chat.messages.map(message => message.content).slice(0, 5), ['First user question', 'A before correction', 'A correction', 'A corrected canonical', 'B question']);
  assert.equal(h.chat.messages[1].answerId, undefined);
  assert.equal(h.chat.messages[3].answerId, 'A-final');
  assert.equal(h.chat.messages[3].thinking, 'A corrected thinking');
  assert.equal(h.chat.activeRequestId, next.requestId);
  assert.equal(h.chat.streaming, true);
  await h.finish(1, 'B canonical');
});

test('offline speculative sends do not outrank recovered authoritative starts or reorder failed history', async t => {
  const h = await setup(t, {resumed: true});
  await h.connect();
  const originalStreamFetch = window.fetch;
  t.mock.method(window, 'fetch', async () => {throw new Error('offline');});
  for (let index = 1; index <= 6; index++) {
    await act(async () => {await h.chat.send(`Offline ${index}`);});
  }
  const failedHistory = h.chat.messages.map(message => ({id: message.id, content: message.content, error: message.error}));
  assert.equal(failedHistory.length, 12);
  assert.equal(failedHistory[1].error, 'offline');
  t.mock.method(window, 'fetch', originalStreamFetch);
  let aCompleted, bAccepted;
  await act(async () => {aCompleted = h.chat.send('Recovered A');});
  const a = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask')).at(-1).body);
  await act(async () => {h.streams[0].event('started', {requestId: a.requestId, question: 'Recovered A', revision: 2}); await nextTick();});
  await act(async () => {bAccepted = h.chat.followUp('Recovered B');});
  const b = JSON.parse(h.requests.filter(request => request.url.endsWith('/ask')).at(-1).body);
  await act(async () => {
    h.streams[1].event('started', {requestId: b.requestId, question: 'Recovered B', revision: 5});
    h.streams[1].event('text', {delta: 'B partial'});
    h.streams[0].event('done', {answer: 'A canonical', answerId: 'A-answer'});
    h.streams[0].close(); await nextTick(); await bAccepted; await aCompleted;
  });
  assert.equal(h.chat.activeRequestId, b.requestId);
  assert.equal(h.chat.streaming, true);
  assert.deepEqual(h.chat.messages.slice(0, 12).map(message => ({id: message.id, content: message.content, error: message.error})), failedHistory);
  assert.deepEqual(h.chat.messages.slice(12, 15).map(message => message.content), ['Recovered A', 'A canonical', 'Recovered B']);
  assert.equal(h.chat.messages[13].answerId, 'A-answer');
  const originalFetch = globalThis.fetch;
  let steeringTarget;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!url.endsWith('/steer')) return originalFetch(url, options);
    const input = JSON.parse(options.body); steeringTarget = input.targetRequestId;
    const message = {id: input.requestId, question: input.question, mode: 'steer', targetRequestId: input.targetRequestId, createdAt: 1, status: 'pending'};
    return Promise.resolve(Response.json({message, state: {revision: 6, activeRequestId: b.requestId, pending: [message]}}));
  });
  await act(async () => {await h.chat.steer('B correction');});
  assert.equal(steeringTarget, b.requestId);
  await act(async () => {h.chat.stop();});
  assert.equal(h.streams[1].signal.aborted, true);
  assert.equal(h.chat.messages[15].stopped, true);
  assert.equal(h.chat.messages[15].content, 'B partial');
  assert.equal(h.chat.streaming, false);
});
