import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { ChatMessage } from "../src/components/ChatMessage.tsx";

function reply(overrides = {}) {
  return { id: "reply-1", role: "assistant", content: "完整回复", thinking: "", tools: [], streaming: false, ...overrides };
}

function text(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node?.children?.map(text).join("") ?? "";
}

async function setup(t, { message = reply(), writeText } = {}) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldWindow = globalThis.window;
  const oldActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const copied = [];
  const timers = new Map();
  let nextTimer = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: writeText === null ? undefined : { writeText: writeText ?? (async (value) => { copied.push(value); }) } },
  });
  globalThis.window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const originalError = console.error;
  t.mock.method(console, "error", (...args) => {
    if (String(args[0]).startsWith("react-test-renderer is deprecated")) return;
    originalError(...args);
  });
  let renderer;
  let mounted = true;
  await act(async () => { renderer = create(React.createElement(ChatMessage, { message })); });
  t.after(async () => {
    if (mounted) await act(async () => { renderer.unmount(); });
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    globalThis.window = oldWindow;
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldActEnvironment;
  });
  return {
    copied, timers,
    get button() { return renderer.root.findByProps({ "aria-label": "复制回复" }); },
    get copyButtons() { return renderer.root.findAllByProps({ "aria-label": "复制回复" }); },
    get text() { return text(renderer.toJSON()); },
    async click() { await act(async () => { void this.button.props.onClick(); }); },
    async update(message) { await act(async () => { renderer.update(React.createElement(ChatMessage, { message })); }); },
    async flushTimers() {
      await act(async () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(({ callback }) => callback());
      });
    },
    async unmount() { await act(async () => { renderer.unmount(); mounted = false; }); },
  };
}

test("only nonempty finished assistant replies offer copying, including stopped partial replies", async (t) => {
  const h = await setup(t);
  for (const overrides of [{}, { stopped: true, content: "部分回复" }]) {
    await h.update(reply(overrides));
    assert.equal(h.copyButtons.length, 1);
  }
  for (const overrides of [{ role: "user" }, { streaming: true }, { content: " \n\t" }, { content: "", stopped: true }]) {
    await h.update(reply(overrides));
    assert.equal(h.copyButtons.length, 0);
  }
});

test("copying preserves complete Markdown including Mermaid source and excludes thinking and tool metadata", async (t) => {
  const markdown = "# 分析\n\n**结论**与 [链接](https://example.test)\n\n```mermaid\ngraph TD\n  A[入口] --> B[结束]\n```\n";
  const h = await setup(t, { message: reply({ content: markdown, thinking: "不复制的思考", tools: [{ name: "read", args: { path: "private.ts" }, isError: false }] }) });
  assert.ok(h.button.props["aria-describedby"]);
  assert.match(h.text, /复制 Markdown 原文/);
  await h.click();
  assert.deepEqual(h.copied, [markdown]);
  assert.match(h.text, /已复制/);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 2000);
  await h.flushTimers();
  assert.doesNotMatch(h.text, /已复制/);
});

test("clipboard rejection shows a useful inline failure and a retry can succeed", async (t) => {
  let attempts = 0;
  const h = await setup(t, { writeText: async () => { if (++attempts === 1) throw new Error("permission denied"); } });
  await h.click();
  assert.match(h.text, /复制失败/);
  assert.match(h.text, /重试|手动/);
  assert.doesNotMatch(h.text, /已复制/);
  assert.equal(h.button.props.disabled, false);
  await h.click();
  assert.equal(attempts, 2);
  assert.match(h.text, /已复制/);
  assert.doesNotMatch(h.text, /复制失败/);
});

test("an unavailable Clipboard API never reports a successful copy", async (t) => {
  const h = await setup(t, { writeText: null });
  await h.click();
  assert.match(h.text, /HTTPS|localhost/);
  assert.doesNotMatch(h.text, /已复制|手动选择/);
  assert.equal(h.timers.size, 0);
});

test("late clipboard completion cannot claim that an updated reply was copied", async (t) => {
  let complete;
  const h = await setup(t, { writeText: () => new Promise((resolve) => { complete = resolve; }) });
  await h.click();
  assert.equal(h.button.props.disabled, true);
  await h.update(reply({ content: "后来的不同回复" }));
  await act(async () => { complete(); });
  assert.doesNotMatch(h.text, /已复制/);
  assert.equal(h.button.props.disabled, false);
  assert.equal(h.timers.size, 0);
});

test("unmount clears the copy feedback timer", async (t) => {
  const h = await setup(t);
  await h.click();
  assert.equal(h.timers.size, 1);
  await h.unmount();
  assert.equal(h.timers.size, 0);
});

test("unmount before clipboard completion does not schedule feedback", async (t) => {
  let complete;
  const h = await setup(t, { writeText: () => new Promise((resolve) => { complete = resolve; }) });
  await h.click();
  await h.unmount();
  await act(async () => { complete(); });
  assert.equal(h.timers.size, 0);
});
