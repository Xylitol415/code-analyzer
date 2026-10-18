import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionQueue } from "../src/session-queue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("canceling queued work leaves the active request running and skips the canceled task", async () => {
  const finish = deferred();
  const started = deferred();
  let aborts = 0;
  let queuedRan = false;
  const queue = new SessionQueue({ abort: async () => { aborts++; }, dispose() {} });
  const first = queue.run(async () => { started.resolve(); await finish.promise; return "first"; });
  await started.promise;
  const controller = new AbortController();
  const second = queue.run(async () => { queuedRan = true; }, controller.signal);
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  assert.equal(aborts, 0);
  finish.resolve();
  assert.equal(await first, "first");
  await rejected;
  assert.equal(queuedRan, false);
});

test("canceling active work aborts it and the next request can run", async () => {
  const finish = deferred();
  const started = deferred();
  let aborts = 0;
  const queue = new SessionQueue({
    abort: async () => { aborts++; finish.resolve(); },
    dispose() {},
  });
  const controller = new AbortController();
  const active = queue.run(async () => { started.resolve(); await finish.promise; }, controller.signal);
  const rejected = assert.rejects(active, { name: "AbortError" });
  await started.promise;
  controller.abort();
  // Also release the fake prompt on the broken implementation, avoiding a hanging test.
  finish.resolve();
  await rejected;
  assert.equal(aborts, 1);
  assert.equal(await queue.run(async () => "next"), "next");
});

test("closing waits for active work, skips queued work, and disposes exactly once", async () => {
  const finish = deferred();
  const started = deferred();
  const events: string[] = [];
  const queue = new SessionQueue({
    abort: async () => { events.push("abort"); },
    dispose: () => { events.push("dispose"); },
  });
  const active = queue.run(async () => {
    started.resolve();
    await finish.promise;
    events.push("finished");
  });
  await started.promise;
  const pending = queue.run(async () => { events.push("queued"); });
  const results = Promise.allSettled([active, pending]);
  const closing = queue.close();
  const closingAgain = queue.close();
  await Promise.resolve();
  const disposedEarly = events.includes("dispose");
  finish.resolve();
  const outcomes = await results;
  await Promise.all([closing, closingAgain]);
  assert.equal(disposedEarly, false);
  assert.deepEqual(events, ["abort", "finished", "dispose"]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  await assert.rejects(queue.run(async () => "too late"), /closed/i);
});

test("an old request signal cannot abort a later request", async () => {
  let aborts = 0;
  const queue = new SessionQueue({ abort: async () => { aborts++; }, dispose() {} });
  const controller = new AbortController();
  await queue.run(async () => "done", controller.signal);
  const next = queue.run(async () => { controller.abort(); return "next"; });
  assert.equal(await next, "next");
  assert.equal(aborts, 0);
});

test("a failed task does not break the queue", async () => {
  const queue = new SessionQueue({ abort: async () => {}, dispose() {} });
  await assert.rejects(queue.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await queue.run(async () => "next"), "next");
});

test("the next request waits until abort finishes even if the prompt already settled", async () => {
  const started = deferred();
  const finish = deferred();
  const abortFinished = deferred();
  const events: string[] = [];
  const queue = new SessionQueue({
    abort: async () => {
      finish.resolve();
      await abortFinished.promise;
      events.push("abort finished");
    },
    dispose() {},
  });
  const controller = new AbortController();
  const first = queue.run(async () => { started.resolve(); await finish.promise; }, controller.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  await started.promise;
  const second = queue.run(async () => { events.push("next"); });
  controller.abort();
  await finish.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ranEarly = events.includes("next");
  abortFinished.resolve();
  await Promise.all([rejected, second]);
  assert.equal(ranEarly, false);
  assert.deepEqual(events, ["abort finished", "next"]);
});
