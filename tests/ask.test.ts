import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsk } from "../src/ask.ts";
import { SessionQueue } from "../src/session-queue.ts";

test("a provider failure is reported instead of resolving as an empty answer", async () => {
  let listener;
  let unsubscribed = false;
  const session = {
    subscribe(callback) {
      listener = callback;
      return () => { unsubscribed = true; };
    },
    async prompt() {
      // The SDK resolves prompt() after an assistant error terminal event.
      listener({ type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error", errorMessage: "401 Invalid API key",
        api: "openai-completions", provider: "custom-openai", model: "custom-model", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
    },
  };
  await assert.rejects(runAsk(session, "question"), /模型服务.*401 Invalid API key/);
  assert.equal(unsubscribed, true);
});

test("cancellation during prompt preparation prevents a model request from starting", async () => {
  const controller = new AbortController();
  let modelStarted = false;
  let subscribed = false;
  // Mirrors the pinned SDK's async preflight followed by its synchronous
  // preflightResult callback, which runs immediately before _runAgentPrompt.
  const session = {
    subscribe() {
      subscribed = true;
      return () => { subscribed = false; };
    },
    async prompt(_question, options) {
      await Promise.resolve();
      controller.abort();
      options?.preflightResult?.(true);
      modelStarted = true;
    },
  };
  const outcome = await Promise.allSettled([runAsk(session, "question", undefined, controller.signal)]);
  assert.equal(modelStarted, false);
  assert.equal(outcome[0].status, "rejected");
  assert.equal(subscribed, false);
});

test("closing a session during preparation cancels the pending prompt before disposal", async () => {
  let prepared!: () => void;
  let preparing!: () => void;
  const preparation = new Promise<void>((resolve) => { prepared = resolve; });
  const started = new Promise<void>((resolve) => { preparing = resolve; });
  let modelStarted = false;
  let disposed = false;
  const session = {
    subscribe: () => () => {},
    async prompt(_question, options) {
      preparing();
      await preparation;
      options?.preflightResult?.(true);
      modelStarted = true;
    },
    abort: async () => {}, // No agent is running during SDK preparation.
    dispose() { disposed = true; },
  };
  const queue = new SessionQueue(session);
  const pending = queue.run((signal) => runAsk(session, "question", undefined, signal));
  const rejected = assert.rejects(pending, /closed/i);
  await started;
  const closing = queue.close();
  assert.equal(disposed, false);
  prepared();
  await Promise.all([rejected, closing]);
  assert.equal(modelStarted, false);
  assert.equal(disposed, true);
});
