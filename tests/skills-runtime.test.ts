import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlledSkillResourceLoader, attachSessionSkills, createPrepareSkillImportTool, getSessionSkills, prepareSessionSkillSteering, applySessionSkillSteering } from "../src/skills/runtime.ts";
import { runAsk } from "../src/ask.ts";

const snapshot = (revision = 1, skills = []) => ({ projectPath: "/project", revision, skills });
const skill = { id: "one", name: "only-explicit", description: "secret description", version: "hash", source: { kind: "file", label: "SKILL.md" }, disableModelInvocation: true, files: [], installedAt: "now", filePath: "/managed/SKILL.md", baseDir: "/managed" };

test("steering expands only the current skill snapshot and authorizes URLs only after adoption", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "steering-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "SKILL.md");
  await writeFile(filePath, "---\nname: only-explicit\ndescription: test\n---\nUse source evidence.");
  const loader = new ControlledSkillResourceLoader("/project", "/missing", "", snapshot(1, [{ ...skill, filePath, baseDir: directory }]));
  const session = { getActiveToolNames: () => [], setActiveToolsByName() { throw Error("must not refresh tools mid-turn"); }, sessionManager: { appendCustomEntry() {} } };
  attachSessionSkills(session, loader, { snapshot: async () => { throw Error("must not refresh snapshot mid-turn"); } });
  loader.beginTurn("https://example.com/first");
  const question = "/skill:only-explicit Explain https://example.com/second";
  const expanded = prepareSessionSkillSteering(session, question);
  assert.match(expanded, /<skill name="only-explicit"/);
  assert.match(expanded, /Use source evidence/);
  assert.doesNotMatch(expanded, /description: test/);
  assert.equal(loader.allowsURL("https://example.com/second"), false);
  applySessionSkillSteering(session, question);
  assert.equal(loader.allowsURL("https://example.com/first"), true);
  assert.equal(loader.allowsURL("https://example.com/second"), true);
  assert.throws(() => prepareSessionSkillSteering(session, "/skill:missing hello"), /未启用/);
  loader.endTurn();
  assert.equal(loader.allowsURL("https://example.com/second"), false);
});

test("controlled loader preserves AGENTS and never discovers local skills/extensions/packages", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "skills-loader-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, ".pi/extensions"), { recursive: true });
  await mkdir(join(project, ".agents/skills/unmanaged"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "Project guidance");
  await writeFile(join(project, ".agents/skills/unmanaged/SKILL.md"), "---\nname: unmanaged\ndescription: should never appear\n---\n");
  await writeFile(join(project, ".pi/extensions/bad.ts"), "throw Error('extension executed')");
  await writeFile(join(project, ".pi/settings.json"), JSON.stringify({ packages: ["npm:never-install-this"] }));
  const loader = new ControlledSkillResourceLoader(project, join(project, "agent"), "app instructions", snapshot(1, [skill]));
  await loader.reload();
  loader.extendResources({ skillPaths: [{ path: join(project, ".agents/skills"), metadata: {} }] });
  assert.equal(loader.getExtensions().extensions.length, 0);
  assert.equal(loader.getSkills().skills.length, 1);
  assert.equal(loader.getSkills().skills[0].disableModelInvocation, true);
  assert.ok(loader.getAgentsFiles().agentsFiles.some((x) => x.content === "Project guidance"));
  assert.deepEqual(loader.getAppendSystemPrompt(), ["app instructions"]);
});

test("runAsk refreshes through public tools API and audits every turn without resetting the runtime", async () => {
  let next = snapshot();
  const service = { snapshot: async () => next };
  const loader = new ControlledSkillResourceLoader("/project", "/missing", "", snapshot(0));
  const calls = [];
  const entries = [];
  const session = {
    subscribe: () => () => {},
    getActiveToolNames: () => ["read", "prepare_skill_import"],
    setActiveToolsByName: (tools) => calls.push([tools, loader.getSkills().skills.map((x) => x.name)]),
    sessionManager: { appendCustomEntry: (type, data) => entries.push({ type, data }) },
    prompt: async () => {},
  };
  attachSessionSkills(session, loader, service);
  const events = [];
  await runAsk(session, "hello", (e) => events.push(e));
  next = snapshot(2, [skill]);
  await runAsk(session, "again", (e) => events.push(e));
  assert.deepEqual(calls[1][1], ["only-explicit"]);
  assert.equal(getSessionSkills(session)?.revision, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].data.revision, 2);
  assert.equal(events.filter((e) => e.type === "skills_applied").length, 2);
});

test("unknown and disabled explicit skill invocation is an actionable host error before prompting", async () => {
  let prompted = false;
  const loader = new ControlledSkillResourceLoader("/project", "/missing", "", snapshot());
  const session = { subscribe: () => () => {}, prompt: async () => { prompted = true; }, getActiveToolNames: () => [], setActiveToolsByName() {}, sessionManager: { appendCustomEntry() {} } };
  attachSessionSkills(session, loader, { snapshot: async () => snapshot() });
  await assert.rejects(runAsk(session, "/skill:missing explain"), /missing.*未启用|未启用.*missing/);
  assert.equal(prompted, false);
  await assert.rejects(runAsk(session, "/skill"), /请指定 Skill 名称/);
});

test("prepare tool accepts only literal URLs in the active original question and forwards preview metadata", async () => {
  const loader = new ControlledSkillResourceLoader("/project", "/missing", "", snapshot());
  const preview = { id: "preview", projectPath: "/project", skill, warnings: [], expiresAt: "later" };
  let prepared = 0;
  let listener;
  const service = { snapshot: async () => snapshot(), prepare: async () => { prepared++; return preview; } };
  const tool = createPrepareSkillImportTool(loader, service);
  const session = {
    subscribe: (callback) => { listener = callback; return () => {}; },
    getActiveToolNames: () => [], setActiveToolsByName() {}, sessionManager: { appendCustomEntry() {} },
    prompt: async () => {
      await assert.rejects(tool.execute("bad", { url: "https://evil.invalid/x" }), /本轮.*URL/);
      const result = await tool.execute("ok", { url: "https://example.com/SKILL.md" });
      listener({ type: "tool_execution_end", toolName: "prepare_skill_import", toolCallId: "ok", result, isError: false });
    },
  };
  attachSessionSkills(session, loader, service);
  const events = [];
  const outcome = await runAsk(session, "import https://example.com/SKILL.md", (e) => events.push(e));
  assert.equal(prepared, 1);
  assert.deepEqual(outcome.skillPreviews, [preview]);
  assert.equal(events.filter((x) => x.type === "skill_preview").length, 1);
  await assert.rejects(tool.execute("after", { url: "https://example.com/SKILL.md" }), /本轮.*URL/);
});

test("real pi session refreshes native skills on the next turn and keeps model, history and tool limits", async (t) => {
  const { createReadOnlySession } = await import("../src/session-factory.ts");
  const { getSkillService } = await import("../src/skills/service.ts");
  const directory = await mkdtemp(join(tmpdir(), "skills-sdk-"));
  const envNames = ["CODE_ANALYZER_DATA_DIR", "PI_CODING_AGENT_DIR"];
  const old = envNames.map((name) => process.env[name]);
  process.env.CODE_ANALYZER_DATA_DIR = join(directory, "data");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  t.after(async () => {
    envNames.forEach((name, i) => old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]);
    await rm(directory, { recursive: true, force: true });
  });
  const { session } = await createReadOnlySession(directory, {
    resume: false, inMemory: true, llm: { baseUrl: "https://never-request.invalid/v1", model: "test" },
  });
  t.after(() => session.dispose());
  const runtime = session.modelRuntime;
  const model = session.model;
  const contexts = [];
  const stream = runtime.streamSimple.bind(runtime);
  t.mock.method(runtime, "streamSimple", (model, context, options) => {
    contexts.push(structuredClone(context));
    return stream(model, context, { ...options, fetch: async () => {
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
  });
  const service = getSkillService();
  await runAsk(session, "first");
  const preview = await service.prepare(directory, { kind: "upload", filename: "SKILL.md", bytes: Buffer.from("---\nname: explicit-only\ndescription: HIDDEN_SKILL_DESCRIPTION\ndisable-model-invocation: true\n---\nNATIVE_SKILL_BODY\n") });
  const confirmed = await service.confirm(preview.id);
  await runAsk(session, "normal question");
  assert.ok(!session.systemPrompt.includes("HIDDEN_SKILL_DESCRIPTION"));
  await runAsk(session, "/skill:explicit-only explain");
  assert.ok(JSON.stringify(contexts[2].messages).includes("NATIVE_SKILL_BODY"));
  assert.equal(session.modelRuntime, runtime);
  assert.equal(session.model, model);
  assert.ok(session.messages.length >= 6);
  assert.deepEqual(session.getActiveToolNames().sort(), ["find", "git", "grep", "ls", "prepare_skill_import", "read"]);
  await service.patch(confirmed.installed.id, { project: directory, enabled: false });
  await assert.rejects(runAsk(session, "/skill explicit-only explain"), /未启用/);
  assert.equal(contexts.length, 3);
  const automatic = await service.prepare(directory, { kind: "upload", filename: "SKILL.md", bytes: Buffer.from("---\nname: automatic\ndescription: NEXT_TURN_DISCOVERY\n---\nAutomatic body\n") });
  await service.confirm(automatic.id);
  assert.ok(!session.systemPrompt.includes("NEXT_TURN_DISCOVERY"));
  await runAsk(session, "next question");
  assert.ok(session.systemPrompt.includes("NEXT_TURN_DISCOVERY"));
  assert.ok(JSON.stringify(contexts[3].messages).includes("NEXT_TURN_DISCOVERY"));
  assert.equal(session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "skills_applied").length, 4);
});

test("cancellation during managed snapshot refresh never prompts or leaves URL authorization", async () => {
  const controller = new AbortController();
  const loader = new ControlledSkillResourceLoader("/project", "/missing", "", snapshot());
  let prompted = false;
  const session = { subscribe: () => () => {}, prompt: async () => { prompted = true; }, getActiveToolNames: () => [], setActiveToolsByName() {}, sessionManager: { appendCustomEntry() {} } };
  attachSessionSkills(session, loader, { snapshot: async () => { controller.abort(); return snapshot(); } });
  await assert.rejects(runAsk(session, "https://example.com/SKILL.md", undefined, controller.signal));
  assert.equal(prompted, false);
  assert.equal(loader.allowsURL("https://example.com/SKILL.md"), false);
});
