import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SessionQueue } from "../src/session-queue.ts";
import { SessionMessages } from "../src/session-messages.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const agent: any = {};
  let aborts = 0;
  const queue = new SessionQueue({ abort: async () => { aborts++; }, dispose() {} });
  const adopted: string[] = [];
  const inbox = new SessionMessages({ agent } as any, queue, message => { adopted.push(message.question); });
  return { agent, queue, inbox, adopted, aborts: () => aborts };
}
const request = (id: string) => ({ id, question: `question ${id}` });

test("pending follow-up deletion settles promptly without aborting the active task", async () => {
  const f = fixture(); const started = deferred(); const finish = deferred(); let ran = false;
  const active = f.inbox.run(request("a"), async () => { started.resolve(); await finish.promise; return "a"; });
  await started.promise;
  const next = f.inbox.run(request("b"), async () => { ran = true; return "b"; });
  const rejected = assert.rejects(next, { name: "AbortError" });
  assert.equal(f.inbox.state().pending[0].id, "b");
  const removed = f.inbox.remove("b");
  assert.equal(removed.message.question, "question b");
  assert.equal(removed.state.pending.length, 0);
  await rejected;
  assert.equal(f.aborts(), 0);
  assert.equal(f.inbox.remove("b").message.id, "b");
  finish.resolve(); await active;
  assert.equal(ran, false);
});

test("adopted steering cannot be deleted and never leaks to a following task", async () => {
  const f = fixture(); const started = deferred(); const finish = deferred();
  const events: string[] = [];
  const active = f.inbox.run(request("a"), async () => { started.resolve(); await finish.promise; }, {
    onSteeringApplied: message => events.push(message.requestId),
  });
  await started.promise;
  f.inbox.steer({ id: "s1", question: "discard", targetRequestId: "a" });
  f.inbox.steer({ id: "s2", question: "correct direction", targetRequestId: "a" });
  f.inbox.remove("s1");
  assert.deepEqual(await f.agent.finishTurn({}), { action: "continue" });
  const update = await f.agent.prepareNextTurnWithContext({});
  assert.equal(update.messages[0].content, "correct direction");
  assert.deepEqual(f.adopted, ["correct direction"]);
  assert.deepEqual(events, ["s2"]);
  assert.throws(() => f.inbox.remove("s2"), (e: any) => e.status === 409);
  finish.resolve(); await active;
  await f.inbox.run(request("b"), async () => {
    assert.equal(await f.agent.prepareNextTurnWithContext({}), undefined);
    assert.throws(() => f.inbox.steer({ id: "late", question: "old", targetRequestId: "a" }), (e: any) => e.status === 409);
  });
});

test("withdrawal wins while public SDK preparation is waiting", async () => {
  const prepared = deferred(); const entered = deferred(); const finish = deferred();
  const agent: any = { prepareNextTurnWithContext: async () => { entered.resolve(); await prepared.promise; return { messages: [] }; } };
  const queue = new SessionQueue({ abort: async () => {}, dispose() {} });
  const inbox = new SessionMessages({ agent } as any, queue, () => { throw new Error("deleted steering was adopted"); });
  const started = deferred();
  const running = inbox.run(request("a"), async () => { started.resolve(); await finish.promise; });
  await started.promise;
  inbox.steer({ id: "s", question: "withdraw me", targetRequestId: "a" });
  const preparation = agent.prepareNextTurnWithContext({}); await entered.promise;
  inbox.remove("s"); prepared.resolve();
  assert.deepEqual((await preparation).messages, []);
  finish.resolve(); await running;
});

test("unconsumed steering remains editable as unapplied and close clears all pending", async () => {
  const f = fixture(); const started = deferred(); const finish = deferred();
  const running = f.inbox.run(request("a"), async () => { started.resolve(); await finish.promise; });
  await started.promise;
  f.inbox.steer({ id: "s", question: "late correction", targetRequestId: "a" });
  finish.resolve(); await running;
  assert.equal(f.inbox.state().pending[0].status, "unapplied");
  assert.equal(f.inbox.remove("s").message.question, "late correction");
  assert.throws(() => f.inbox.remove("a"), (e: any) => e.status === 409);
  f.inbox.close();
  await assert.rejects(f.inbox.run(request("b"), async () => {}), /closed/i);
});

test("stopping current work preserves queued follow-up and does not adopt its old steering", async () => {
  const f = fixture(); const started = deferred(); const stopped = new AbortController();
  const active = f.inbox.run(request("active"), async signal => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, { signal: stopped.signal });
  const rejected = assert.rejects(active);
  await started.promise;
  f.inbox.steer({ id: "steer", question: "Only for active", targetRequestId: "active" });
  const queued = f.inbox.run(request("queued"), async () => {
    assert.equal(await f.agent.prepareNextTurnWithContext({}), undefined);
    return "next";
  });
  stopped.abort();
  await rejected;
  assert.equal(await queued, "next");
  assert.equal(f.aborts(), 1);
  assert.equal(f.inbox.state().pending[0].status, "unapplied");
});

test("closing clears pending follow-ups immediately while active work completes its cleanup", async () => {
  const f = fixture(); const started = deferred(); const finish = deferred();
  const active = f.inbox.run(request("active"), async () => { started.resolve(); await finish.promise; });
  const rejected = assert.rejects(active);
  await started.promise;
  let ran = false;
  const pending = f.inbox.run(request("queued"), async () => { ran = true; });
  const removed = assert.rejects(pending, { name: "AbortError" });
  f.inbox.close(); const closed = f.queue.close();
  await removed;
  assert.deepEqual(f.inbox.state().pending, []);
  finish.resolve(); await rejected; await closed;
  assert.equal(ran, false);
});

test("steering cannot expand a previous skills snapshot while the active task prepares context", async () => {
  const started = deferred(); const finish = deferred();
  const agent: any = { state: { isStreaming: false } };
  const queue = new SessionQueue({ abort: async () => {}, dispose() {} });
  let expanded = 0;
  const inbox = new SessionMessages({ agent } as any, queue, () => {}, question => { expanded++; return question; });
  const active = inbox.run(request("a"), async () => { started.resolve(); await finish.promise; });
  await started.promise;
  assert.throws(() => inbox.steer({ id: "old", question: "/skill:removed explain", targetRequestId: "a" }), (error: any) => error.status === 409 && /准备|结束/.test(error.message));
  assert.equal(expanded, 0);
  assert.deepEqual(inbox.state().pending, []);
  // runAsk has selected the current snapshot before the SDK begins streaming.
  agent.state.isStreaming = true;
  inbox.steer({ id: "current", question: "Current snapshot", targetRequestId: "a" });
  assert.equal(expanded, 1);
  agent.state.isStreaming = false;
  assert.throws(() => inbox.steer({ id: "late", question: "finishing", targetRequestId: "a" }), (error: any) => error.status === 409);
  finish.resolve(); await active;
});

test("committing a continuation adopts its steering before async SDK preparation", async () => {
  const entered = deferred(); const prepared = deferred(); const finished = deferred(); const started = deferred();
  const agent: any = { prepareNextTurnWithContext: async () => { entered.resolve(); await prepared.promise; return { messages: [] }; } };
  const queue = new SessionQueue({ abort: async () => {}, dispose() {} });
  const applied: string[] = [];
  const inbox = new SessionMessages({ agent } as any, queue, message => { applied.push(message.requestId); });
  const active = inbox.run(request("a"), async () => { started.resolve(); await finished.promise; });
  await started.promise;
  inbox.steer({ id: "s", question: "Correction for the next turn", targetRequestId: "a" });
  assert.deepEqual(await agent.finishTurn({}), { action: "continue" });
  const preparation = agent.prepareNextTurnWithContext({}); await entered.promise;
  assert.throws(() => inbox.remove("s"), (error: any) => error.status === 409);
  assert.deepEqual(applied, [], "applied event waits for actual delivery");
  prepared.resolve();
  assert.equal((await preparation).messages[0].content, "Correction for the next turn");
  assert.deepEqual(applied, ["s"], "committed steering must be applied once");
  finished.resolve(); await active;
});

test("actual pi loop never continues without the steering that committed its next turn", { timeout: 5000 }, async t => {
  // Resolve the SDK's public transitive dependency, independent of hoisting.
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const corePackage = pathToFileURL(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
  const { Agent } = await import(new URL("./dist/index.js", corePackage).href);
  for (const mode of ["delete-before-commit", "deliver-committed", "preparation-fails"] as const) await t.test(mode, async () => {
    const first = deferred(); const releaseFirst = deferred(); const preparing = deferred(); const releasePrepare = deferred();
    let calls = 0;
    const agent = new Agent({
      initialState: { model: { id: "fake", provider: "local", api: "openai-completions" }, tools: [] },
      prepareNextTurnWithContext: async () => {
        preparing.resolve(); await releasePrepare.promise;
        if (mode === "preparation-fails") throw new Error("Simulated compaction failure");
      },
      streamFn: async () => {
        calls++;
        if (calls === 1) { first.resolve(); await releaseFirst.promise; }
        const message = { role: "assistant", content: [{ type: "text", text: calls === 1 ? "Initial" : "Corrected" }], stopReason: "stop",
          api: "openai-completions", provider: "local", model: "fake", timestamp: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message };
      },
    });
    const queue = new SessionQueue({ abort: async () => agent.abort(), dispose() {} });
    const applied: string[] = [];
    const inbox = new SessionMessages({ agent }, queue, message => { applied.push(message.requestId); });
    const run = inbox.run(request("a"), () => agent.prompt("Original"));
    try {
      await first.promise;
      inbox.steer({ id: "s", question: "Correction", targetRequestId: "a" });
      if (mode === "delete-before-commit") inbox.remove("s");
      releaseFirst.resolve();
      if (mode !== "delete-before-commit") {
        await preparing.promise;
        assert.throws(() => inbox.remove("s"), (error: any) => error.status === 409);
        assert.deepEqual(applied, []);
      }
      releasePrepare.resolve(); await run;
      assert.equal(calls, mode === "deliver-committed" ? 2 : 1);
      assert.deepEqual(applied, mode === "deliver-committed" ? ["s"] : []);
      const users = agent.state.messages.filter((message: any) => message.role === "user")
        .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((block: any) => block.text ?? "").join(""));
      assert.deepEqual(users, mode === "deliver-committed" ? ["Original", "Correction"] : ["Original"]);
      if (mode === "preparation-fails") assert.equal(inbox.state().pending[0].status, "unapplied");
    } finally { releaseFirst.resolve(); releasePrepare.resolve(); await run.catch(() => {}); }
  });
});
