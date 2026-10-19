import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../src/api/client.ts";

test("history requests encode the selected project and use backend authentication", async (t) => {
  const calls = [];
  const result = { projectPath: "/repo & docs", sessions: [{ id: "history-1", title: "Architecture", createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T01:00:00Z", messageCount: 2 }] };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(result);
  });
  assert.deepEqual(await client.listHistory({ baseUrl: "http://backend.test", token: "history-token" }, "/repo & docs"), result);
  assert.equal(calls[0].url, "http://backend.test/history?project=%2Frepo%20%26%20docs");
  assert.equal(calls[0].headers.Authorization, "Bearer history-token");
});

test("history authentication failures stay visible instead of becoming an empty list", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  await assert.rejects(() => client.listHistory({ baseUrl: "http://backend.test", token: "wrong" }, "/repo"), /401.*Token/);
});
