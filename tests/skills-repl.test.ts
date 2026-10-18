import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSkillsCommand } from "../src/repl.ts";

function fixture() {
  const calls = [];
  const preview = { id: "preview-id", projectPath: "/actual-project", skill: { id: "skill-id", name: "review", description: "Review code with references", version: "hash", source: { kind: "local", label: "/tmp/source" }, disableModelInvocation: true, files: [{ path: "SKILL.md", size: 100 }, { path: "references/guide.md", size: 50 }] }, replacement: { id: "skill-id", name: "review", version: "old-hash" }, warnings: ["No script execution"], expiresAt: "soon" };
  const service = {
    list: async (project) => { calls.push(["list", project]); return { installed: [{ id: "skill-id", name: "review", version: "hash", enabled: true }], local: [{ localId: "candidate", name: "local", source: "discovered" }] }; },
    prepare: async (project, input) => { calls.push(["prepare", project, input]); return preview; },
    patch: async (id, input) => { calls.push(["patch", id, input]); },
    confirm: async (id) => { calls.push(["confirm", id]); return { installed: { name: "review" } }; },
  };
  const output = [];
  const context = { projectPath: "/actual-project", service, pending: new Map(), write: (line) => output.push(line) };
  return { calls, preview, output, context };
}

test("REPL host commands bind list, imports and toggles to actual project and never ask the model", async () => {
  const { calls, output, context } = fixture();
  assert.equal(await executeSkillsCommand("hello", context), false);
  await executeSkillsCommand("/skills list", context);
  await executeSkillsCommand('/skills import "/tmp/skill folder/SKILL.md"', context);
  await executeSkillsCommand("/skills import https://example.com/SKILL.md", context);
  await executeSkillsCommand("/skills import local:candidate", context);
  await executeSkillsCommand("/skills disable review", context);
  assert.ok(output.join("\n").includes("preview-id"));
  assert.match(output.join("\n"), /Review code with references/);
  assert.match(output.join("\n"), /来源 \(local\): \/tmp\/source/);
  assert.match(output.join("\n"), /references\/guide.md \(50 B\)/);
  assert.match(output.join("\n"), /替换: review @ old-hash/);
  assert.match(output.join("\n"), /仅显式调用/);
  assert.deepEqual(calls.find((entry) => entry[0] === "patch"), ["patch", "skill-id", { project: "/actual-project", enabled: false }]);
  assert.deepEqual(calls.filter((entry) => entry[0] === "prepare").map((entry) => entry[2]), [{ kind: "path", path: "/tmp/skill folder/SKILL.md" }, { kind: "url", url: "https://example.com/SKILL.md" }, { kind: "local", localId: "candidate" }]);
  assert.ok(!calls.some((entry) => entry[0] === "confirm"));
});

test("REPL confirmation is explicit, scoped to pending preview and idempotent", async () => {
  const { calls, context } = fixture();
  await assert.rejects(executeSkillsCommand("/skills confirm unrelated", context), /当前项目.*预览/);
  await executeSkillsCommand("/skills import https://example.com/SKILL.md", context);
  await executeSkillsCommand("/skills confirm preview-id", context);
  await executeSkillsCommand("/skills confirm preview-id", context);
  assert.equal(calls.filter((entry) => entry[0] === "confirm").length, 2);
});

test("non-TTY REPL buffers input, waits for explicit confirmation and disposes on EOF", { timeout: 15000 }, async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { SkillService } = await import("../src/skills/service.ts");
  const directory = await mkdtemp(join(tmpdir(), "skills-repl-pipe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const source = join(directory, "source");
  const dataDir = join(directory, "appdata");
  await mkdir(project);
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "---\nname: piped-skill\ndescription: Piped skill\n---\nInstructions\n");
  const sourceRoot = resolve("src");
  const code = `
    import { startRepl } from ${JSON.stringify(join(sourceRoot, "repl.ts"))};
    import { ControlledSkillResourceLoader, attachSessionSkills } from ${JSON.stringify(join(sourceRoot, "skills/runtime.ts"))};
    import { getSkillService } from ${JSON.stringify(join(sourceRoot, "skills/service.ts"))};
    const service = getSkillService();
    const project = process.env.REPL_TEST_PROJECT;
    const snapshot = await service.snapshot(project);
    const session = { subscribe: () => () => {}, abort: async () => {}, dispose: () => console.log("DISPOSED"), getActiveToolNames: () => [], setActiveToolsByName() {}, sessionManager: { appendCustomEntry() {} }, prompt: async () => { throw Error("MODEL_SHOULD_NOT_RUN"); } };
    attachSessionSkills(session, new ControlledSkillResourceLoader(project, project, "", snapshot), service);
    await startRepl(session);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: resolve("."), env: { ...process.env, CODE_ANALYZER_DATA_DIR: dataDir, REPL_TEST_PROJECT: project }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const previewId = await new Promise<string>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`REPL preview timeout: ${output} ${errors}`)), 10000);
    child.once("error", reject);
    child.stdout.on("data", (data) => {
      output += data;
      const id = /Skill 预览 ([0-9a-f-]{36})/.exec(output)?.[1];
      if (id) { clearTimeout(timeout); done(id); }
    });
    child.stdin.write(`/skills import ${source}\n/skills list\n`);
  });
  const service = new SkillService({ dataDir, homeDir: directory });
  assert.equal((await service.snapshot(project)).skills.length, 0);
  assert.ok(!output.includes("确认向"));
  const closed = new Promise((done) => child.once("close", done));
  child.stdin.end(`/skills confirm ${previewId}\n/skills list\n`);
  const exitCode = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`REPL close timeout: ${output} ${errors}`)), 5000).unref())]);
  assert.equal(exitCode, 0, errors);
  assert.equal((await service.snapshot(project)).skills[0].name, "piped-skill");
  assert.match(output, /DISPOSED/);
  assert.ok(!output.includes("MODEL_SHOULD_NOT_RUN"));
});
