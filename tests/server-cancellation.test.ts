import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/server.js";
import { closeSession } from "../src/session-registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise: Promise<unknown>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("real HTTP disconnect cancels the upstream model before or during output and keeps the session usable", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-analyzer-cancellation-"));
  const project = join(directory, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  let sessionId: string | undefined;
  let mode: "empty" | "partial" | "complete" = "empty";
  let started = deferred();
  let closed = deferred();
  let requests = 0;

  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before replying. */ }
    requests++;
    const chunk = (content: string, finishReason: string | null = null) => `data: ${JSON.stringify({
      id: "cancel-test", object: "chat.completion.chunk", created: 1, model: "cancel-test-model",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finishReason }],
    })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (mode === "complete") {
      response.end(chunk("Next question works", "stop") + "data: [DONE]\n\n");
      return;
    }
    response.once("close", closed.resolve);
    if (mode === "partial") response.write(chunk("Partial answer"));
    started.resolve();
    // Deliberately never finish: only cancellation can close this response.
  });
  const app = createApp("cancellation-test-token");
  const backend = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  t.after(async () => {
    // Release sockets first, including when a cancellation assertion fails.
    provider.closeAllConnections();
    backend.closeAllConnections();
    if (sessionId) await closeSession(sessionId);
    await Promise.all([
      new Promise<void>((resolve) => provider.close(() => resolve())),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    }),
    backend.listening ? Promise.resolve() : once(backend, "listening"),
  ]);
  const providerAddress = provider.address();
  const backendAddress = backend.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  assert.ok(backendAddress && typeof backendAddress === "object");
  const baseUrl = `http://127.0.0.1:${backendAddress.port}`;
  const headers = { "content-type": "application/json", authorization: "Bearer cancellation-test-token" };
  const create = await fetch(`${baseUrl}/sessions`, {
    method: "POST", headers,
    body: JSON.stringify({ project, llm: { baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, model: "cancel-test-model" } }),
  });
  assert.equal(create.status, 200);
  sessionId = (await create.json()).id;

  for (const output of ["empty", "partial"] as const) {
    mode = output;
    started = deferred();
    closed = deferred();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/sessions/${sessionId}/ask`, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ question: `Start ${output} response` }),
    });
    assert.equal(response.status, 200);
    await within(started.promise, "The local provider did not receive the request");
    if (output === "partial") {
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /Partial answer/);
      reader.releaseLock();
    }
    controller.abort();
    await within(closed.promise, `${output}: stopping HTTP did not close the upstream model response`);

    // Queue cleanup must finish so a later question can use the same session.
    mode = "complete";
    const next = await fetch(`${baseUrl}/sessions/${sessionId}/ask`, {
      method: "POST", headers, signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ question: "Ask again" }),
    });
    const events = await next.text();
    assert.match(events, /Next question works/);
    assert.match(events, /event: done/);
    assert.doesNotMatch(events, /event: error/);
  }
  assert.equal(requests, 4);
});
