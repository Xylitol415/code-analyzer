import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "../src/components/ChatMessage.tsx";

function renderMessage(overrides = {}) {
  return renderToStaticMarkup(React.createElement(ChatMessage, {
    message: {
      id: "assistant-1",
      role: "assistant",
      content: "",
      thinking: "",
      tools: [],
      streaming: false,
      ...overrides,
    },
  }));
}

test("a reply stopped before any output explains the empty message", () => {
  const html = renderMessage({ stopped: true });
  assert.match(html, /已停止回复/);
  assert.match(html, /尚未生成回复内容，你可以重新提问。/);
  assert.doesNotMatch(html, /正在思考|animate-spin|本次未返回回复内容/);
});

test("a stopped reply keeps partial text and details without showing a running tool", () => {
  const html = renderMessage({
    stopped: true,
    content: "已生成的部分回复",
    thinking: "检查入口文件",
    tools: [{ name: "read", args: { path: "index.ts" } }],
  });
  assert.match(html, /已生成的部分回复/);
  assert.match(html, /检查入口文件/);
  assert.match(html, /read/);
  assert.match(html, /已停止回复/);
  assert.doesNotMatch(html, /animate-spin|尚未生成回复内容/);
});

test("a completed empty reply has a retry hint rather than a blank avatar", () => {
  const html = renderMessage();
  assert.match(html, /本次未返回回复内容，请重试。/);
  assert.doesNotMatch(html, /已停止回复|animate-spin/);
});

test("an error explains an empty reply without a duplicate empty-result hint", () => {
  const html = renderMessage({ error: "模型连接失败" });
  assert.match(html, /模型连接失败/);
  assert.doesNotMatch(html, /本次未返回回复内容|尚未生成回复内容|animate-spin/);
});

test("an unfinished historical tool is not displayed as still running or successful", () => {
  const html = renderMessage({
    content: "读取文件时会话中断",
    tools: [{ name: "read", args: { path: "index.ts" } }],
  });
  assert.match(html, /未收到工具结果/);
  assert.doesNotMatch(html, /animate-spin|text-emerald-500|已停止回复/);
});
