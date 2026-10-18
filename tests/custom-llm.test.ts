import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlySession } from "../src/session-factory.ts";
import { runAsk } from "../src/ask.ts";

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "code-analyzer-llm-"));
  const names = ["PI_CODING_AGENT_DIR", "CODE_ANALYZER_MODEL", "CODE_ANALYZER_API_KEY", "CODE_ANALYZER_BASE_URL"];
  const previous = names.map((name) => process.env[name]);
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.CODE_ANALYZER_MODEL = "missing/server-default";
  process.env.CODE_ANALYZER_API_KEY = "server-secret-must-not-be-used";
  process.env.CODE_ANALYZER_BASE_URL = "https://server-default.invalid/v1";
  t.after(async () => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function mockCompletion(requests) {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get("authorization"), body: await request.json() });
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
      id: "completion-1", object: "chat.completion.chunk", created: 1, model: "org/private-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "verified" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  };
}

test("custom sessions send the requested endpoint, literal key and full model name through the SDK", async (t) => {
  const directory = await workspace(t);
  const { session, modelLabel } = await createReadOnlySession(directory, {
    resume: false, inMemory: true,
    llm: { baseUrl: "  https://gateway.invalid/v1///  ", apiKey: "  !$LITERAL_KEY  ", model: " org/private-model " },
  });
  t.after(() => session.dispose());
  assert.equal(session.model?.id, "org/private-model");
  assert.match(modelLabel, /org\/private-model$/);
  const requests = [];
  const answer = await session.modelRuntime.completeSimple(session.model!, {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  }, { fetch: mockCompletion(requests) });
  assert.equal(answer.stopReason, "stop");
  assert.equal(answer.content[0].text, "verified");
  assert.equal(requests[0].url, "https://gateway.invalid/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer !$LITERAL_KEY");
  assert.equal(requests[0].body.model, "org/private-model");
  assert.ok(!JSON.stringify(session.sessionManager.getEntries()).includes("!$LITERAL_KEY"));
});

test("custom sessions isolate credentials and never inherit server keys when the key is omitted", async (t) => {
  const directory = await workspace(t);
  const first = await createReadOnlySession(directory, {
    resume: false, inMemory: true,
    llm: { baseUrl: "https://first.invalid/v1", apiKey: "first-secret", model: "same-model" },
  });
  t.after(() => first.session.dispose());
  const second = await createReadOnlySession(directory, {
    resume: false, inMemory: true,
    llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "same-model" },
  });
  t.after(() => second.session.dispose());
  const requests = [];
  await Promise.all([first, second].map(({ session }) => session.modelRuntime.completeSimple(session.model!, {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  }, { fetch: mockCompletion(requests) })));
  assert.equal(requests.find((r) => r.url.startsWith("https://first.invalid"))?.authorization, "Bearer first-secret");
  const local = requests.find((r) => r.url.startsWith("http://127.0.0.1"));
  assert.ok(local);
  assert.ok(!JSON.stringify(local).includes("first-secret"));
  assert.ok(!JSON.stringify(requests).includes("server-secret"));
});

test("invalid custom options fail before model lookup without echoing credentials", async (t) => {
  const directory = await workspace(t);
  const valid = { baseUrl: "https://gateway.invalid/v1", apiKey: "private-secret", model: "my-model" };
  for (const options of [
    { llm: { ...valid, baseUrl: "file:///private-secret" } },
    { llm: { ...valid, baseUrl: "https://user:private-secret@gateway.invalid/v1" } },
    { llm: { ...valid, baseUrl: "https://gateway.invalid/v1?key=private-secret" } },
    { llm: { ...valid, model: " " } },
    { llm: { ...valid, apiKey: "private-secret\nheader" } },
    { llm: valid, modelId: "openai/existing" },
    { llm: null },
  ]) {
    await assert.rejects(
      createReadOnlySession(directory, { resume: false, inMemory: true, ...options }),
      (error) => error.name === "LlmConfigError" && !error.message.includes("private-secret"),
    );
  }
});

test("provider errors redact the session key before returning or persisting the error", async (t) => {
  const directory = await workspace(t);
  const apiKey = "synthetic-private-key";
  const { session } = await createReadOnlySession(directory, {
    resume: false,
    llm: { baseUrl: "https://gateway.invalid/v1", apiKey, model: "custom-model" },
  });
  t.after(() => session.dispose());
  const runtime = session.modelRuntime;
  const stream = runtime.streamSimple.bind(runtime);
  t.mock.method(runtime, "streamSimple", (model, context, options) => stream(model, context, {
    ...options,
    fetch: async () => Response.json({ error: { message: `Incorrect API key provided: ${apiKey}`, type: "authentication_error" } }, { status: 401 }),
  }));
  await assert.rejects(runAsk(session, "hello"), (error) => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes(apiKey));
    return true;
  });
  assert.ok(!JSON.stringify(session.messages).includes(apiKey));
  assert.ok(!JSON.stringify(session.sessionManager.getEntries()).includes(apiKey));
  const persisted = await readFile(session.sessionManager.getSessionFile()!, "utf8");
  assert.ok(!persisted.includes(apiKey));
});
