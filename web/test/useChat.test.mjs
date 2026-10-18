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

async function setup(t) {
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
      const info = { id: `session-${++nextId}`, projectPath: "/project", modelLabel: "Test model", resumed: false };
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
  globalThis.window = { fetch, setTimeout, clearTimeout };
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
    delayCreates() { delayCreates = true; },
    async render(serverConfig) {
      await act(async () => { root.update(React.createElement(Harness, { serverConfig })); });
    },
    async connect() { await act(async () => { await chat.connect("/project", false); }); },
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
  await h.connect();
  assert.deepEqual([...h.sessions], ["session-2"]);
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.chat.sessionId, "session-2");
});

test("a late session response after reset is released and cannot reconnect the UI", async (t) => {
  const h = await setup(t);
  h.delayCreates();
  let connecting;
  await act(async () => { connecting = h.chat.connect("/project", false); });
  await act(async () => { h.chat.newSession(); });
  await act(async () => { h.pendingCreates[0].finish(); await connecting; });
  assert.equal(h.sessions.size, 0);
  assert.equal(h.chat.sessionId, null);
  assert.equal(h.streams.length, 0);
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
  assert.equal(h.streams.length, 1);
});

test("stopping before the first reply marks the message stopped and aborts the request", async (t) => {
  const h = await setup(t);
  await h.connect();
  await act(async () => { h.chat.stop(); });
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.chat.streaming, false);
  assert.equal(h.chat.messages[0].streaming, false);
  assert.equal(h.chat.messages[0].stopped, true);
  assert.equal(h.chat.messages[0].content, "");
  assert.equal(h.chat.messages[0].error, undefined);
});

test("stopped stream completion and late events cannot alter a replacement stream", async (t) => {
  const h = await setup(t);
  await h.connect();
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
  assert.equal(h.chat.messages[0].content, "partial answer");
  assert.equal(h.chat.messages[0].thinking, "partial thinking");
  assert.deepEqual(h.chat.messages[0].tools, [{ name: "read", args: { path: "index.ts" } }]);
  assert.equal(h.chat.messages[0].error, undefined);
  assert.equal(h.chat.messages[0].streaming, false);
  assert.equal(h.chat.messages[0].stopped, true);
});

test("questions and cleanup use the configuration that created the session", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.finish(0, "hello");
  await h.render({ baseUrl: "http://second.test", token: "second-token" });
  let question;
  await act(async () => { question = h.chat.send("where is the code?"); });
  await h.finish(1, "here");
  await question;
  await act(async () => { h.chat.newSession(); });
  const questionRequest = h.requests.filter((request) => request.url.endsWith("/ask"))[1];
  const deletion = h.requests.find((request) => request.method === "DELETE");
  assert.equal(questionRequest.url, "http://first.test/sessions/session-1/ask");
  assert.equal(questionRequest.headers.Authorization, "Bearer first-token");
  assert.equal(deletion.url, "http://first.test/sessions/session-1");
  assert.equal(deletion.headers.Authorization, "Bearer first-token");
});

test("unmount releases the active server session", async (t) => {
  const h = await setup(t);
  await h.connect();
  await h.unmount();
  assert.equal(h.sessions.size, 0);
  assert.equal(h.streams[0].signal.aborted, true);
});
