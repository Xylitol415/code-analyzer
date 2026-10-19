import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server.ts";
import { closeSession, getSession } from "../src/session-registry.ts";
import { historyMessages } from "../src/session-history.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("real pi adopts steering at a boundary, deletes queued work immediately and runs follow-ups independently", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "steering-http-"));
  const project = join(directory, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(project, "entry.ts"), "export const enabled = true;\n");
  const first = deferred(); const releaseFirst = deferred();
  const second = deferred(); const releaseSecond = deferred();
  const bodies: any[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    const index = bodies.length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (index === 1) { first.resolve(); await releaseFirst.promise; }
    if (index === 2) { second.resolve(); await releaseSecond.promise; }
    const delta = (content: object, stop: string | null) => `data: ${JSON.stringify({
      id: "steering", object: "chat.completion.chunk", created: 1, model: "local-test",
      choices: [{ index: 0, delta: content, finish_reason: stop }],
    })}\n\n`;
    const content = index === 1 ? { role: "assistant", content: "Original segment", tool_calls: [{ index: 0, id: "read-entry", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "entry.ts" }) } }] }
      : { role: "assistant", content: index === 2 ? "Corrected answer" : "Queued answer" };
    response.end(delta(content, index === 1 ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  let id: string | undefined;
  t.after(async () => {
    releaseFirst.resolve(); releaseSecond.resolve(); provider.closeAllConnections();
    if (id) await closeSession(id);
    if (provider.listening) await new Promise<void>(done => provider.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((done, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", done); });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const app = createApp("steering-test");
  const headers = { authorization: "Bearer steering-test", "content-type": "application/json" };
  const post = (path: string, data: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(data) });
  const created = await post("/sessions", { project, llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "local-test" } });
  assert.equal(created.status, 200); id = (await created.json()).id;
  const path = `/sessions/${id}`;
  assert.equal((await app.request(`${path}/messages`)).status, 401);
  assert.equal((await post(`${path}/steer`, null)).status, 400);
  assert.equal((await post(`${path}/ask`, { question: "bad mode", mode: "steer" })).status, 400);
  const activeResponse = await post(`${path}/ask`, { requestId: "active", question: "Original question" });
  const activeText = activeResponse.text();
  await first.promise;
  const queued = await post(`${path}/ask`, { requestId: "next", question: "Independent next question", mode: "followUp" });
  const queuedText = queued.text();
  const discarded = await post(`${path}/ask`, { requestId: "discard", question: "Must not execute", mode: "followUp" });
  const discardedText = discarded.text();
  let state = await (await app.request(`${path}/messages`, { headers })).json();
  assert.equal(state.activeRequestId, "active");
  assert.deepEqual(state.pending.map((entry: any) => entry.id), ["next", "discard"]);
  const deleted = await app.request(`${path}/messages/discard`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.match(await discardedText, /event: cancelled/);
  assert.equal(bodies.length, 1, "queued deletion must not abort or advance the model");
  assert.equal((await app.request(`${path}/messages/discard`, { method: "DELETE", headers })).status, 200);
  assert.equal((await post(`${path}/steer`, { requestId: "wrong", question: "wrong target", targetRequestId: "finished" })).status, 409);
  assert.equal((await post(`${path}/steer`, { requestId: "withdraw", question: "Ignore me", targetRequestId: "active" })).status, 202);
  assert.equal((await app.request(`${path}/messages/withdraw`, { method: "DELETE", headers })).status, 200);
  assert.equal((await post(`${path}/steer`, { requestId: "correction", question: "Only explain the read path", targetRequestId: "active" })).status, 202);
  releaseFirst.resolve(); await second.promise;
  assert.equal((await app.request(`${path}/messages/correction`, { method: "DELETE", headers })).status, 409);
  assert.equal((await app.request(`${path}/messages/active`, { method: "DELETE", headers })).status, 409);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /Only explain the read path/);
  assert.ok(bodies[1].messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("enabled = true")), "steering preserves the completed tool pair");
  assert.doesNotMatch(JSON.stringify(bodies[1]), /Ignore me|Must not execute|Independent next question/);
  releaseSecond.resolve();
  const activeEvents = await activeText; const nextEvents = await queuedText;
  assert.match(activeEvents, /event: steering_applied/);
  assert.ok(activeEvents.indexOf("event: steering_applied") < activeEvents.indexOf('"delta":"Corrected answer"'));
  assert.match(activeEvents, /"answer":"Corrected answer"/);
  assert.match(activeEvents, /"name":"read","phase":"end","isError":false/);
  assert.doesNotMatch(activeEvents, /event: error/);
  assert.match(nextEvents, /event: started/); assert.match(nextEvents, /Queued answer/);
  assert.doesNotMatch(nextEvents, /event: error/);
  assert.equal(bodies.length, 3);
  assert.match(JSON.stringify(bodies[2].messages.at(-1)), /Independent next question/);
  const history = historyMessages(getSession(id!)!.session.sessionManager.getBranch());
  assert.deepEqual(history.map(message => message.content), ["Original question", "Original segment", "Only explain the read path", "Corrected answer", "Independent next question", "Queued answer"]);
  state = await (await app.request(`${path}/messages`, { headers })).json();
  assert.equal(state.activeRequestId, null); assert.deepEqual(state.pending, []);
});
