import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));

test("listing history exits without selecting a model or waiting for stdin", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "analyzer-cli-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", project, "--list-sessions"], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(directory, "agent"),
      CODE_ANALYZER_API_KEY: "",
      CODE_ANALYZER_MODEL: "provider-that-does-not-exist/model",
      CODE_ANALYZER_BASE_URL: "",
    },
    encoding: "utf8",
    timeout: 15_000,
    input: "",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /暂无历史会话/);
  assert.doesNotMatch(result.stdout + result.stderr, /未找到模型|API key|选择会话/);
});

test("listing history for an uncached remote project does not clone it", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "analyzer-cli-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/main.ts", `https://127.0.0.1:1/${randomUUID()}.git`, "--list-sessions",
  ], {
    cwd: root, encoding: "utf8", timeout: 15_000, input: "",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /暂无历史会话/);
  assert.doesNotMatch(result.stdout + result.stderr, /正在 clone|Cloning/);
});

test("CLI lists persisted histories and restores a selected older ID instead of the latest", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "analyzer-cli-history-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agent = join(directory, "agent");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const project = join(directory, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const makeHistory = (title: string) => {
    const manager = SessionManager.create(project);
    manager.appendMessage({ role: "user", content: title, timestamp: 1 });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Existing answer" }],
      api: "openai-completions", provider: "custom-openai", model: "test-model", timestamp: 2, stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    return manager.getSessionId();
  };
  const older = makeHistory("Older discussion");
  const newer = makeHistory("Newer discussion");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", project, ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000, input: "",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, CODE_ANALYZER_API_KEY: "", CODE_ANALYZER_MODEL: "missing/model", CODE_ANALYZER_BASE_URL: "" },
  });
  const listed = run(["--list-sessions"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes(older));
  assert.ok(listed.stdout.includes(newer));
  assert.match(listed.stdout, /Older discussion/);
  assert.match(listed.stdout, /Newer discussion/);
  const resumed = run(["--session", older, "--base-url=http://127.0.0.1:1/v1", "--model=test-model", "--api-key="]);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.ok(resumed.stdout.includes(`会话 ID: ${older}`));
  assert.match(resumed.stdout, /已恢复 2 条历史消息/);
  assert.doesNotMatch(resumed.stdout, /选择会话/);
});

test("typing exit terminates the CLI even when stdin remains open", { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "analyzer-cli-exit-"));
  const project = join(directory, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const child = spawn(process.execPath, [
    "--import", "tsx", "src/main.ts", project, "--new",
    "--base-url=http://127.0.0.1:1/v1", "--model=test-model", "--api-key=",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent"),
      CODE_ANALYZER_API_KEY: "", CODE_ANALYZER_MODEL: "missing/model", CODE_ANALYZER_BASE_URL: "",
    },
  });
  let output = "";
  let sentExit = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    if (!sentExit && output.includes("> ")) {
      sentExit = true;
      // Deliberately do not end stdin: exiting must release readline itself.
      child.stdin.write("exit\n");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    const result = await closed;
    assert.ok(sentExit, `CLI never reached its input prompt: ${output}`);
    assert.equal(result.signal, null, `CLI did not exit after the exit command: ${output}`);
    assert.equal(result.code, 0, output);
  } finally {
    clearTimeout(timeout);
  }
});
