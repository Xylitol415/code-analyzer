import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { MermaidDiagram } from "../src/components/MermaidDiagram.tsx";
import { Markdown } from "../src/components/Markdown.tsx";
import { diagramDefinition, mermaidRenderer } from "../src/lib/mermaid-renderer.ts";

async function setup(t, Component = MermaidDiagram, props = { source: "graph LR\nA-->B", complete: true, streaming: false }) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const error = console.error;
  t.mock.method(console, "error", (...args) => {
    if (!String(args[0]).startsWith("react-test-renderer is deprecated")) error(...args);
  });
  const requests = [];
  t.mock.method(mermaidRenderer, "render", (source) => new Promise((resolve, reject) => requests.push({ source, resolve, reject })));
  let root;
  await act(async () => { root = create(React.createElement(Component, props)); });
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  return {
    root, requests,
    update: async (props) => act(async () => root.update(React.createElement(Component, props))),
    get text() { return JSON.stringify(root.toJSON()); },
    get images() { return root.root.findAllByType("img"); },
  };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="5" y="20">调用链</text></svg>';

test("an incomplete stream does not request rendering, then a closed fence becomes an SVG image", async (t) => {
  const h = await setup(t, MermaidDiagram, { source: "graph LR\nA-->", complete: false, streaming: true });
  assert.equal(h.requests.length, 0);
  assert.match(h.text, /图表生成中/);
  await h.update({ source: "graph LR\nA-->B", complete: true, streaming: true });
  assert.equal(h.requests.length, 1);
  await act(async () => h.requests[0].resolve(svg));
  assert.equal(h.images.length, 1);
  assert.equal(decodeURIComponent(h.images[0].props.src.split(",")[1]), svg);
  assert.equal(h.root.root.findAllByType("pre").length, 0);
  assert.equal(h.root.root.findAllByType("svg").length, 0, "SVG must be displayed as an isolated image");
});

test("late render results cannot replace a newer source, and failures never show parser text", async (t) => {
  const h = await setup(t);
  await h.update({ source: "graph LR\nB-->C", complete: true, streaming: false });
  await act(async () => h.requests[0].resolve(svg));
  assert.equal(h.images.length, 0);
  await act(async () => h.requests[1].reject(new Error("SOURCE_SECRET syntax error")));
  assert.match(h.text, /图表未能生成/);
  assert.doesNotMatch(h.text, /SOURCE_SECRET|syntax error/);
});

test("wide architecture diagrams retain a readable width inside the horizontal scroll region", async (t) => {
  const h = await setup(t);
  await act(async () => h.requests[0].resolve(svg.replace('0 0 100 50', '0 0 2400 600')));
  assert.equal(h.images[0].props.style.minWidth, 2400);
  assert.ok(h.root.root.findByProps({ role: "region" }).props.className.includes("overflow-x-auto"));
});

test("finishing or stopping an incomplete diagram replaces the spinner with an explanation", async (t) => {
  const h = await setup(t, MermaidDiagram, { source: "graph LR\nA-->", complete: false, streaming: true });
  await h.update({ source: "graph LR\nA-->", complete: false, streaming: false });
  assert.match(h.text, /图表未完成，可复制回复原文查看/);
  assert.doesNotMatch(h.text, /animate-spin/);
  assert.equal(h.requests.length, 0);
});

test("a completed diagram is not remounted or rerendered as later Markdown tokens arrive", async (t) => {
  const source = "```mermaid\ngraph LR\nA-->B\n```\n\n";
  const h = await setup(t, Markdown, { children: source, streaming: true });
  await act(async () => h.requests[0].resolve(svg));
  await h.update({ children: source + "后续分析", streaming: true });
  await h.update({ children: source + "后续分析完成。", streaming: false });
  assert.equal(h.requests.length, 1);
  assert.equal(h.images.length, 1);
});

test("unmounted diagrams ignore in-flight rendering and image failures remain recoverable", async (t) => {
  const h = await setup(t);
  await act(async () => h.requests[0].resolve(svg));
  await act(async () => h.images[0].props.onError());
  assert.match(h.text, /图表未能生成/);
  await h.update({ source: "graph LR\nB-->C", complete: true, streaming: false });
  await act(async () => h.root.unmount());
  await act(async () => h.requests[1].resolve(svg));
  assert.equal(h.root.toJSON(), null);
});

test("diagram configuration is removed only from the rendering copy and oversized input is rejected", async () => {
  const body = "flowchart LR\nA-->B";
  const source = '---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"themeCSS":"body { color: red }"}}%%\n' + body;
  assert.equal(diagramDefinition(source).trim(), body);
  assert.ok(source.includes("securityLevel: loose"));
  await assert.rejects(mermaidRenderer.render("x".repeat(50_001)), /rendering limit/);
});
