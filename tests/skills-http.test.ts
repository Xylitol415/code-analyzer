import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { closeSession, getSession } from "../src/session-registry.js";
import { getSessionSkills } from "../src/skills/runtime.js";

const token = "skills-http-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const content = '---\nname: architecture\ndescription: Explain architecture with evidence\n---\nUse the fixture reference to explain architecture.\n';
async function setup(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "skills-http-")));
  const project = join(directory, "project");
  const other = join(directory, "other");
  await Promise.all([project, other].map((p) => mkdir(join(p, ".git"), { recursive: true })));
  const names = ["CODE_ANALYZER_DATA_DIR", "PI_CODING_AGENT_DIR"];
  const previous = names.map((name) => process.env[name]);
  process.env.CODE_ANALYZER_DATA_DIR = join(directory, "data");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  const ids = new Set<string>();
  t.after(async () => {
    for (const id of ids) await closeSession(id);
    names.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]);
    await rm(directory, { recursive: true, force: true });
  });
  const app = createApp(token);
  const json = (path, body, method = "POST") => app.request(path, { method, headers, body: JSON.stringify(body) });
  const upload = (path = project) => {
    const form = new FormData();
    form.set("project", path);
    form.set("file", new Blob([content], { type: "text/markdown" }), "SKILL.md");
    return app.request("/skills/imports", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  };
  const open = async (selectedProject = project, options = {}) => {
    const response = await json("/sessions", { project: selectedProject, llm: { baseUrl: "https://skills-llm.invalid/v1", model: "fixture-model", apiKey: "fixture-key" }, ...options });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json(); ids.add(result.id); return result;
  };
  return { app, project, other, json, upload, open };
}

test("skills HTTP authentication, bounded parsing and explicit confirmation keep project bindings", async t => {
  const { app, project, other, json, upload } = await setup(t);
  assert.equal((await app.request(`/skills?project=${encodeURIComponent(project)}`)).status, 401);
  assert.equal((await app.request("/skills/imports/anything/confirm", { method: "POST" })).status, 401);
  assert.equal((await json("/skills/imports", { project, path: "/etc/passwd" })).status, 400);
  assert.equal((await json("/skills/imports", { project, url: "http://127.0.0.1/SKILL.md" })).status, 400);
  const oversized = await app.request("/skills/imports", { method: "POST", headers: { ...headers, "content-length": String(22 * 1024 * 1024) }, body: "{}" });
  assert.equal(oversized.status, 413);
  const previewResponse = await upload();
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assert.equal(preview.projectPath, project);
  const list = (path) => app.request(`/skills?project=${encodeURIComponent(path)}`, { headers });
  assert.deepEqual((await (await list(project)).json()).installed, []);
  const confirmed = await json(`/skills/imports/${preview.id}/confirm`, { project: other });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const result = await confirmed.json();
  assert.equal(result.snapshot.projectPath, project);
  assert.equal(result.snapshot.skills[0].name, "architecture");
  assert.deepEqual((await (await list(other)).json()).installed.map(s => s.enabled), [false]);
  assert.deepEqual(await (await json(`/skills/imports/${preview.id}/confirm`, {})).json(), result);
  assert.equal(await readFile(result.snapshot.skills[0].filePath, "utf8"), content);
  assert.equal((await json(`/skills/${result.installed.id}`, { project, enabled: false }, "PATCH")).status, 200);
  assert.equal((await (await list(project)).json()).installed[0].enabled, false);
});

test("session creation, skill preview and SSE use the same project identity through a symlink", async t => {
  const { project, app, open, upload } = await setup(t);
  const alias = project + "-alias";
  await symlink(project, alias, "dir");
  const sessionInfo = await open(alias);
  assert.equal(sessionInfo.projectPath, project);
  const preview = await (await upload(alias)).json();
  assert.equal(preview.projectPath, sessionInfo.projectPath);
  const entry = getSession(sessionInfo.id)!;
  t.mock.method(entry.session, "prompt", async () => {});
  const response = await app.request(`/sessions/${sessionInfo.id}/ask`, { method: "POST", headers, body: JSON.stringify({ question: "hello" }) });
  const data = /event: skills_applied\ndata: (.+)/.exec(await response.text());
  assert.ok(data);
  assert.equal(JSON.parse(data[1]).projectPath, sessionInfo.projectPath);
});

test("session metadata and SSE apply confirmed skills on the next turn, retaining model runtime", async t => {
  const { app, project, json, upload, open } = await setup(t);
  const sessionInfo = await open();
  assert.deepEqual(sessionInfo.skills, []);
  assert.equal(sessionInfo.skillsRevision, 0);
  const entry = getSession(sessionInfo.id)!;
  const runtime = entry.session.modelRuntime;
  const calls: string[] = [];
  t.mock.method(entry.session, "prompt", async (question, options) => {
    await options?.preflightResult?.();
    calls.push(question);
    entry.session.sessionManager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
    entry.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixture answer" }],
      api: "openai-completions", provider: "custom-openai", model: "fixture-model", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
  });
  const preview = await (await upload()).json();
  const installed = await (await json(`/skills/imports/${preview.id}/confirm`, {})).json();
  assert.equal(getSessionSkills(entry.session)?.skills.length, 0);
  const answer = await app.request(`/sessions/${sessionInfo.id}/ask`, { method: "POST", headers, body: JSON.stringify({ question: "Explain this project" }) });
  const events = await answer.text();
  assert.match(events, /event: skills_applied/);
  assert.match(events, /"name":"architecture"/);
  assert.equal(getSessionSkills(entry.session)?.skills[0].version, installed.installed.version);
  assert.equal(entry.session.modelRuntime, runtime);
  assert.ok(entry.session.systemPrompt.includes("architecture"));
  assert.equal(calls.length, 1);
  await json(`/skills/${installed.installed.id}`, { project, enabled: false }, "PATCH");
  const invalid = await json(`/sessions/${sessionInfo.id}/ask?stream=false`, { question: "/skill:architecture inspect" });
  assert.equal(invalid.status, 500);
  assert.match((await invalid.json()).error, /未启用|不存在/);
  assert.equal(calls.length, 1);
  assert.ok(!entry.session.systemPrompt.includes('<name>architecture</name>'));
  await closeSession(sessionInfo.id);
  const restored = await open(project, { historyId: sessionInfo.historyId });
  assert.equal(restored.resumed, true);
  assert.equal(restored.historyId, sessionInfo.historyId);
  assert.deepEqual(restored.messages.map(message => message.content), ["Explain this project", "Fixture answer"]);
  assert.deepEqual(restored.skills, []);
  assert.equal(restored.skillsRevision, 2);
});
