import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_HISTORY_KEY, loadConfigurationHistory, rememberConfiguration, saveConfigurationHistory, clearConfigurationHistory } from "../src/config-history.ts";

const input = { project: "/workspace/demo", baseUrl: "http://127.0.0.1:8787", modelMode: "custom", model: "unused", llmBaseUrl: "https://gateway.test/v1", llmModel: "org/model" };
function storage() {
  const items = new Map();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
}

test("configuration history is capped at ten, deduplicates normalized active fields, and moves a reused entry to the front", () => {
  let entries = [];
  for (let i = 0; i < 12; i++) entries = rememberConfiguration(entries, { ...input, project: `/workspace/${i}` }, i);
  assert.equal(entries.length, 10);
  assert.deepEqual(entries.map(entry => entry.project), Array.from({ length: 10 }, (_, i) => `/workspace/${11 - i}`));
  const prior = entries[5];
  entries = rememberConfiguration(entries, { ...input, project: ` ${prior.project} `, baseUrl: input.baseUrl + "/", llmBaseUrl: input.llmBaseUrl + "///", model: "different-unused-model" }, 100);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].id, prior.id);
  assert.equal(entries[0].usedAt, 100);
  assert.equal(entries.filter(entry => entry.project === prior.project).length, 1);
});

test("only explicitly allowed configuration fields can be written or restored, including a credential-bearing caller object", () => {
  const store = storage();
  const extra = { token: "private-backend-token", apiKey: "private-model-key", llmApiKey: "another-private-key", sessionId: "private-session", messages: ["private-message"] };
  const entries = rememberConfiguration([], { ...input, ...extra }, 100);
  assert.equal(saveConfigurationHistory(entries.map(entry => ({ ...entry, ...extra })), store), true);
  const raw = store.items.get(CONFIG_HISTORY_KEY);
  assert.doesNotMatch(raw, /private-|apiKey|llmApiKey|"token"|sessionId|messages/);
  const payload = JSON.parse(raw);
  payload.entries[0] = { ...payload.entries[0], ...extra };
  store.setItem(CONFIG_HISTORY_KEY, JSON.stringify(payload));
  const restored = loadConfigurationHistory(store);
  assert.equal(restored[0].project, input.project);
  assert.equal(restored[0].model, "", "unused backend selection must not pollute a custom configuration");
  assert.doesNotMatch(JSON.stringify(restored), /private-|apiKey|llmApiKey|"token"|sessionId|messages/);
});

test("URLs embedding credentials or query parameters are not saved as configuration history", () => {
  for (const override of [
    { baseUrl: "https://user:password@backend.test" },
    { llmBaseUrl: "https://gateway.test/v1?api_key=secret" },
    { project: "https://user:password@git.test/team/repo.git" },
    { project: "https://git.test/repo.git?token=secret" },
  ]) assert.deepEqual(rememberConfiguration([], { ...input, ...override }), []);
  assert.equal(rememberConfiguration([], { ...input, project: "git@github.com:example/repo.git" }).length, 1);
});

test("unavailable, corrupt and unknown-format storage falls back safely; clear only removes this application's history", () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); }, removeItem() { throw Error("blocked"); } };
  assert.deepEqual(loadConfigurationHistory(blocked), []);
  assert.equal(saveConfigurationHistory(rememberConfiguration([], input), blocked), false);
  assert.equal(clearConfigurationHistory(blocked), false);
  const store = storage();
  for (const text of ["{broken", "null", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [null, {}, { ...input, id: "bad-time", usedAt: "yesterday" }] })]) {
    store.setItem(CONFIG_HISTORY_KEY, text);
    assert.deepEqual(loadConfigurationHistory(store), []);
  }
  store.setItem("unrelated-preference", "keep");
  assert.equal(clearConfigurationHistory(store), true);
  assert.equal(store.items.get("unrelated-preference"), "keep");
  assert.equal(store.items.has(CONFIG_HISTORY_KEY), false);
});
