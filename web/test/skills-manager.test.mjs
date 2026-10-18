import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { SkillsManager } from "../src/components/SkillsManager.tsx";

const binding = { config: { baseUrl: "http://original.test", token: "backend-token" }, project: "/project", connected: true };
const skill = { id: "skill", name: "review", description: "Review logic", version: "v2", source: { kind: "url", label: "https://public.test/SKILL.md" }, disableModelInvocation: false, files: [{ path: "SKILL.md", size: 30 }, { path: "references/policy.md", size: 90 }], installedAt: "2026-10-19" };
const library = { projectPath: "/project", revision: 4, installed: [{ ...skill, enabled: true }, { ...skill, version: "v1", enabled: false }], local: [{ localId: "local-id", name: "local-review", description: "A local skill", source: "/project/.agents/skills/review" }] };
const preview = { id: "preview", projectPath: "/project", skill, warnings: ["Scripts are never executed"], replacement: { id: "skill", name: "review", version: "v1" }, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };

function text(node) { return typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node?.children?.map(text).join("") ?? ""; }
async function setup(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options = {}) => new Promise((resolve) => requests.push({ url, ...options, reply: (body, status = 200) => resolve(Response.json(body, { status })) })));
  const oldWindow = globalThis.window;
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const originalError = console.error;
  t.mock.method(console, "error", (...args) => { if (!String(args[0]).startsWith("react-test-renderer is deprecated")) originalError(...args); });
  let root;
  await act(async () => { root = create(React.createElement(SkillsManager, { binding, appliedCount: 1, appliedRevision: 3, key: "first" })); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.window = oldWindow; globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct; });
  const h = {
    requests,
    get root() { return root.root; },
    get text() { return text(root.toJSON()); },
    button(label) { return root.root.findAllByType("button").find((button) => text(button) === label || button.props["aria-label"] === label); },
    async click(label) { const button = h.button(label); assert.ok(button, `Missing button: ${label}`); assert.ok(!button.props.disabled); await act(async () => { void button.props.onClick(); }); },
    async reply(index, body, status) { await act(async () => requests[index].reply(body, status)); },
    async open() { await h.click("Skills 管理"); await h.reply(requests.length - 1, library); },
    async inputUrl(value) { await act(async () => root.root.findByProps({ "aria-label": "技能 URL" }).props.onChange({ target: { value } })); },
    async submitUrl() { await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} })); },
    async replace(nextBinding) { await act(async () => root.update(React.createElement(SkillsManager, { binding: nextBinding, appliedCount: 0, appliedRevision: 0, key: "replacement" }))); },
  };
  return h;
}

test("independent manager loads its project library, previews local files and requires a separate confirm", async (t) => {
  const h = await setup(t);
  assert.equal(h.requests.length, 0);
  await h.open();
  assert.equal(h.requests[0].url, "http://original.test/skills?project=%2Fproject");
  assert.match(h.text, /当前会话已应用 1 个技能 · 修订 3/);
  assert.match(h.text, /下一次提问.*历史上下文/);
  await h.click("预览 local-review");
  assert.deepEqual(JSON.parse(h.requests[1].body), { project: "/project", localId: "local-id" });
  await h.reply(1, preview);
  assert.equal(h.requests.length, 2, "prepare must never confirm automatically");
  assert.match(h.text, /将替换已启用/);
  assert.match(h.text, /Scripts are never executed/);
  assert.match(h.text, /references\/policy.md/);
  await h.click("确认导入并启用");
  assert.ok(h.requests[2].url.endsWith("/skills/imports/preview/confirm"));
  await h.reply(2, { previewId: "preview", installed: skill, snapshot: { projectPath: "/project", revision: 5, skills: [skill] } });
  await h.reply(3, { ...library, revision: 5 });
  assert.match(h.text, /已导入并启用/);
});

test("version selection and disable submit explicit version-scoped project updates", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.click("停用 review");
  assert.deepEqual(JSON.parse(h.requests[1].body), { project: "/project", enabled: false, version: "v2" });
  await h.reply(1, {});
  await h.reply(2, library);
  await act(async () => h.root.findByProps({ "aria-label": "review 版本" }).props.onChange({ target: { value: "v1" } }));
  await h.click("切换并启用 review");
  assert.deepEqual(JSON.parse(h.requests[3].body), { project: "/project", enabled: true, version: "v1" });
  await h.reply(3, {});
  await h.reply(4, { ...library, revision: 6 });
  assert.match(h.text, /下一次提问生效/);
});

test("URL validation blocks credentials and upload sends the chosen file before a preview", async (t) => {
  const h = await setup(t);
  await h.open();
  for (const value of ["http://public.test/SKILL.md", "https://user:secret@public.test/SKILL.md"]) {
    await h.inputUrl(value);
    assert.equal(h.button("预览 URL").props.disabled, true);
    await h.submitUrl();
  }
  assert.equal(h.requests.length, 1);
  await h.inputUrl("https://public.test/SKILL.md");
  assert.equal(h.button("预览 URL").props.disabled, false);
  await h.submitUrl();
  assert.deepEqual(JSON.parse(h.requests[1].body), { project: "/project", url: "https://public.test/SKILL.md" });
  await h.reply(1, preview);
  const file = new File(["hello"], "skill.zip", { type: "application/zip" });
  await act(async () => h.root.findByProps({ "aria-label": "上传技能文件" }).props.onChange({ target: { files: [file], value: "skill.zip" } }));
  assert.equal(h.requests[2].body.get("file").name, "skill.zip");
  await h.reply(2, preview);
});

test("confirmation failure stays inline, expiry disables confirm and a replaced binding ignores late confirmation", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.click("预览 local-review");
  await h.reply(1, preview);
  await h.click("确认导入并启用");
  await h.reply(2, { error: "Preview expired" }, 410);
  assert.match(h.text, /Preview expired/);
  await h.click("确认导入并启用");
  await h.replace({ config: { baseUrl: "http://new.test", token: "new-token" }, project: "/new-project", connected: true });
  await h.reply(3, { previewId: "preview", installed: skill, snapshot: { projectPath: "/project", revision: 5, skills: [skill] } });
  assert.equal(h.requests.length, 4, "late confirm must not fetch into the new binding");
  assert.doesNotMatch(h.text, /已导入并启用/);
  await h.click("Skills 管理");
  await h.reply(4, { ...library, projectPath: "/new-project" });
  assert.equal(h.requests[4].headers.Authorization, "Bearer new-token");
  await h.click("预览 local-review");
  await h.reply(5, { ...preview, projectPath: "/new-project", expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(h.button("确认导入并启用").props.disabled, true);
  assert.match(h.text, /预览已过期/);
});

test("disabling an older enabled version preserves that choice across refresh and re-enables the same version", async (t) => {
  const h = await setup(t);
  const olderEnabled = { ...library, installed: library.installed.map((item) => ({ ...item, enabled: item.version === "v1" })) };
  const disabled = { ...library, revision: 5, installed: library.installed.map((item) => ({ ...item, enabled: false })) };
  await h.click("Skills 管理");
  await h.reply(0, olderEnabled);
  assert.equal(h.root.findByProps({ "aria-label": "review 版本" }).props.value, "v1");
  await h.click("停用 review");
  assert.deepEqual(JSON.parse(h.requests[1].body), { project: "/project", enabled: false, version: "v1" });
  await h.reply(1, {});
  await h.reply(2, disabled);
  assert.equal(h.root.findByProps({ "aria-label": "review 版本" }).props.value, "v1");
  await h.click("刷新技能");
  await h.reply(3, disabled);
  assert.equal(h.root.findByProps({ "aria-label": "review 版本" }).props.value, "v1");
  await h.click("启用 review");
  assert.deepEqual(JSON.parse(h.requests[4].body), { project: "/project", enabled: true, version: "v1" });
  await h.reply(4, {});
  await h.reply(5, { ...olderEnabled, revision: 6 });
  assert.equal(h.root.findByProps({ "aria-label": "review 版本" }).props.value, "v1");
});
