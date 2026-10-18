import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { closeSession } from "../src/session-registry.js";

const token = "http-test-token";
const app = createApp(token);

function post(path: string, body: unknown, authorization = `Bearer ${token}`) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}

test("HTTP authentication still protects custom LLM requests", async () => {
  const response = await post("/sessions", {
    project: "/missing-project",
    llm: { baseUrl: "http://localhost:8000/v1", model: "local-model" },
  }, "Bearer incorrect-token");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.equal((await app.request("/health")).status, 200);
});

test("HTTP entry points reject invalid custom configuration before resolving the project", async () => {
  const invalidBodies = [
    null,
    [],
    { llm: null },
    { llm: [] },
    { llm: { baseUrl: "http://localhost:8000/v1", model: "" } },
    { llm: { baseUrl: "file:///tmp/test-secret", model: "local-model", apiKey: "test-secret" } },
    { llm: { baseUrl: "http://localhost:8000/v1", model: "local-model", apiKey: { value: "test-secret" } } },
    { modelId: "provider/model", llm: { baseUrl: "http://localhost:8000/v1", model: "local-model", apiKey: "test-secret" } },
  ];
  for (const path of ["/sessions", "/ask", "/ask?stream=true"]) {
    for (const invalid of invalidBodies) {
      const body = invalid && !Array.isArray(invalid)
        ? { project: "/missing-project", question: "hello", ...invalid }
        : invalid;
      const response = await post(path, body);
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(invalid)}`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const text = await response.text();
      assert.doesNotMatch(text, /test-secret/);
      assert.equal(typeof JSON.parse(text).error, "string");
      assert.doesNotMatch(text, /not found|不存在/);
    }
  }
});

test("HTTP entry points report malformed JSON consistently", async () => {
  for (const path of ["/sessions", "/ask"]) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid json body" });
  }
});

test("one-shot session creation failures remain JSON for both response modes", async () => {
  for (const path of ["/ask", "/ask?stream=true"]) {
    const response = await post(path, {
      project: process.cwd(),
      question: "hello",
      modelId: "http-test-missing-provider/http-test-missing-model",
    });
    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match((await response.json()).error, /未找到模型/);
  }
});

test("custom HTTP sessions and one-shot requests use the supplied OpenAI endpoint in JSON and SSE modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-analyzer-http-"));
  const project = join(directory, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let sessionId: string | undefined;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  t.after(async () => {
    if (sessionId) await closeSession(sessionId);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  });

  const requests: Array<{ path?: string; authorization?: string; model: string }> = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, model: JSON.parse(body).model });
    const data = (delta: object, finishReason: string | null) => `data: ${JSON.stringify({
      id: "http-test-completion", object: "chat.completion.chunk", created: 1, model: "org/local-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(data({ role: "assistant", content: "HTTP verified" }, null) + data({}, "stop") + "data: [DONE]\n\n");
  });
  t.after(async () => {
    provider.closeAllConnections();
    if (provider.listening) await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const llm = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "http-upstream-secret", model: "org/local-model" };

  const create = await post("/sessions", { project, llm });
  assert.equal(create.status, 200);
  const created = await create.json();
  sessionId = created.id;
  assert.match(created.modelLabel, /org\/local-model$/);
  assert.doesNotMatch(JSON.stringify(created), /http-upstream-secret/);
  for (const path of [`/sessions/${created.id}/ask?stream=false`, "/ask"]) {
    const response = await post(path, { project, llm, question: "hello" });
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.answer, "HTTP verified");
    assert.match(answer.modelLabel, /org\/local-model$/);
    assert.doesNotMatch(JSON.stringify(answer), /http-upstream-secret/);
  }
  for (const path of [`/sessions/${created.id}/ask`, "/ask?stream=true"]) {
    const response = await post(path, { project, llm, question: "hello" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await response.text();
    assert.match(events, /event: text/);
    assert.match(events, /event: done/);
    assert.match(events, /HTTP verified/);
    assert.doesNotMatch(events, /http-upstream-secret|event: error/);
  }
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.deepEqual(request, { path: "/v1/chat/completions", authorization: "Bearer http-upstream-secret", model: "org/local-model" });
  }
  const deleted = await app.request(`/sessions/${created.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
});
