import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown.tsx";

function renderMarkdown(source, props = {}) {
  return renderToStaticMarkup(React.createElement(Markdown, { ...props, children: source }));
}

function assertDiagramPlaceholder(html, expected) {
  assert.ok(html.includes(expected), `Expected diagram status: ${expected}`);
  assert.doesNotMatch(html, /<pre\b|<code\b|SOURCE_NODE_/);
}

test("a completed Mermaid fence shows a drawing placeholder instead of diagram source", () => {
  const html = renderMarkdown("```mermaid\nflowchart LR\nSOURCE_NODE_A --> SOURCE_NODE_B\n```");
  assertDiagramPlaceholder(html, "正在绘制图表…");
  assert.doesNotMatch(html, /图表生成中|图表未完成/);
});

test("an unfinished streaming diagram waits for its closing fence without exposing source", () => {
  const html = renderMarkdown("```mermaid\nflowchart LR\nSOURCE_NODE_A -->", { streaming: true });
  assertDiagramPlaceholder(html, "图表生成中…");
  assert.doesNotMatch(html, /正在绘制图表|图表未完成/);
});

test("an unfinished diagram after stop or completion explains why no graph is shown", () => {
  for (const props of [{ streaming: false }, {}]) {
    const html = renderMarkdown("```mermaid\nflowchart LR\nSOURCE_NODE_A -->", props);
    assertDiagramPlaceholder(html, "图表未完成，可复制回复原文查看。");
    assert.doesNotMatch(html, /正在绘制图表|图表生成中/);
  }
});

test("a completed diagram can render while a later diagram is still streaming", () => {
  const html = renderMarkdown([
    "第一张图", "", "```mermaid", "flowchart LR", "SOURCE_NODE_A --> SOURCE_NODE_B", "```",
    "", "第二张图", "", "```mermaid", "sequenceDiagram", "SOURCE_NODE_C->>SOURCE_NODE_D:",
  ].join("\n"), { streaming: true });
  assertDiagramPlaceholder(html, "正在绘制图表…");
  assert.equal(html.split("正在绘制图表…").length - 1, 1);
  assert.equal(html.split("图表生成中…").length - 1, 1);
  assert.match(html, /第一张图/);
  assert.match(html, /第二张图/);
});

test("multiple completed diagrams each get their own placeholder", () => {
  const html = renderMarkdown([
    "```mermaid", "flowchart LR", "SOURCE_NODE_A --> SOURCE_NODE_B", "```",
    "", "```mermaid", "sequenceDiagram", "SOURCE_NODE_C->>SOURCE_NODE_D: hello", "```",
  ].join("\n"));
  assertDiagramPlaceholder(html, "正在绘制图表…");
  assert.equal(html.split("正在绘制图表…").length - 1, 2);
});

test("Mermaid language matching accepts mixed case and tilde fences", () => {
  for (const source of [
    "```Mermaid\nflowchart LR\nSOURCE_NODE_A --> SOURCE_NODE_B\n```",
    "~~~MERMAID\nflowchart LR\nSOURCE_NODE_A --> SOURCE_NODE_B\n~~~",
  ]) {
    assertDiagramPlaceholder(renderMarkdown(source), "正在绘制图表…");
  }
});

test("Mermaid fences inside blockquotes and list items keep their surrounding Markdown", () => {
  const quoted = renderMarkdown("> 说明\n>\n> ```mermaid\n> flowchart LR\n> SOURCE_NODE_A --> SOURCE_NODE_B\n> ```");
  assertDiagramPlaceholder(quoted, "正在绘制图表…");
  assert.match(quoted, /<blockquote>/);
  assert.match(quoted, /说明/);
  const listed = renderMarkdown("- 说明\n\n  ```mermaid\n  flowchart LR\n  SOURCE_NODE_A --> SOURCE_NODE_B\n  ```");
  assertDiagramPlaceholder(listed, "正在绘制图表…");
  assert.match(listed, /<li>/);
  assert.match(listed, /说明/);
});

test("a different fence character or a shorter fence does not finish a streaming diagram", () => {
  for (const source of [
    "~~~mermaid\nflowchart LR\nSOURCE_NODE_A --> SOURCE_NODE_B\n```",
    "````mermaid\nflowchart LR\nSOURCE_NODE_A --> SOURCE_NODE_B\n```",
  ]) {
    assertDiagramPlaceholder(renderMarkdown(source, { streaming: true }), "图表生成中…");
  }
});

test("ordinary fenced code still receives syntax highlighting and inline code stays inline", () => {
  const html = renderMarkdown("```javascript\nconst answer = 42;\n```\n\n使用 `mermaid` 和 `value` 变量。");
  assert.match(html, /<code[^>]*class="language-javascript"/);
  assert.match(html, /<span[^>]*>const<\/span>/);
  assert.match(html, /answer/);
  assert.match(html, /<code>mermaid<\/code>/);
  assert.match(html, /<code>value<\/code>/);
  assert.doesNotMatch(html, /图表生成中|正在绘制图表|图表未完成/);
});
