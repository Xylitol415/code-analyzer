import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function startServer(t: TestContext, port: number) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "src/server.ts", "--host", "127.0.0.1",
    "--port", String(port), "--token", "test-startup-secret",
  ], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  let output = "";
  const outputListeners = new Set<() => void>();
  const collect = (chunk: string) => {
    output += chunk;
    for (const listener of outputListeners) listener();
  };
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);
  child.on("error", (error) => { output += error.message; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(forceKill); }
  });

  const waitForOutput = (pattern: RegExp): Promise<RegExpMatchArray> => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      outputListeners.delete(check);
    };
    const check = () => {
      const match = output.match(pattern);
      if (match) { cleanup(); resolve(match); }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server output: ${output}`));
    }, 12_000);
    outputListeners.add(check);
    void closed.then(() => {
      if (!settled) {
        cleanup();
        reject(new Error(`Server exited before listening: ${output}`));
      }
    });
    check();
  });

  return { closed, waitForOutput, output: () => output };
}

test("an occupied port reports a clean startup failure without announcing success or printing the token", { timeout: 20_000 }, async (t) => {
  const occupied = createServer();
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");

  const server = startServer(t, address.port);
  const exit = await server.closed;
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.match(server.output(), /已被占用/);
  assert.ok(server.output().includes(`127.0.0.1:${address.port}`));
  assert.doesNotMatch(server.output(), /已启动|test-startup-secret|Unhandled 'error'/);
});

test("port zero announces the actual listening port and serves health checks", { timeout: 20_000 }, async (t) => {
  const server = startServer(t, 0);
  const match = await server.waitForOutput(/监听: http:\/\/127\.0\.0\.1:(\d+)/);
  const port = Number(match[1]);
  assert.ok(port > 0 && port <= 65_535, "startup output must contain the assigned port");
  assert.match(server.output(), /已启动/);

  const health = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.setTimeout(3_000, () => request.destroy(new Error("Health request timed out")));
    request.on("error", reject);
  });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });
});
