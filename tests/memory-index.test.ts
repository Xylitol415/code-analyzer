import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { IndexChange } from "../src/memory/types.js";

async function indexClass() {
  const module = await import("../src/memory/index.js").catch(() => undefined);
  assert.ok(module?.ZvecKnowledgeIndex, "the reviewed knowledge index must be implemented");
  return module.ZvecKnowledgeIndex;
}

const document = (id: string, text: string, sourceKey = "source-a", policyHash = "policy-a") => ({
  id, projectId: "project-a", sourceKey, policyHash, text,
});
const change = (id: string, text: string, sourceKey?: string, policyHash?: string): IndexChange => ({
  seq: 1, op: "upsert", id, document: document(id, text, sourceKey, policyHash),
});
const query = (question: string) => ({ projectId: "project-a", sourceKey: "source-a", policyHash: "policy-a", question, limit: 5 });

test("zvec searches Chinese reviewed knowledge and persists update/delete across reopen", async () => {
  const Index = await indexClass();
  const dataDir = await mkdtemp(join(tmpdir(), "memory-index-"));
  try {
    const index = new Index({ dataDir });
    await index.sync("project-a", [change("popup", "会员首页弹窗优先级由展示资格与排序规则决定"), change("cancel", "停止按钮会中止模型请求")]);
    assert.ok((await index.search(query("会员弹窗优先级"))).includes("popup"));
    await index.close();
    const reopened = new Index({ dataDir });
    assert.deepEqual(await reopened.search(query("中止模型")), ["cancel"]);
    await reopened.sync("project-a", [change("cancel", "历史会话恢复时重新配置模型凭据"), { seq: 2, op: "delete", id: "popup" }]);
    assert.deepEqual(await reopened.search(query("中止")), []);
    assert.deepEqual(await reopened.search(query("弹窗优先级")), []);
    assert.deepEqual(await reopened.search(query("历史会话")), ["cancel"]);
    await reopened.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("index isolates project, source revision and policy and treats search input as literal text", async () => {
  const Index = await indexClass();
  const dataDir = await mkdtemp(join(tmpdir(), "memory-index-isolation-"));
  try {
    const index = new Index({ dataDir });
    await index.sync("project-a", [change("valid", "会话中止请求"), change("old-source", "会话中止请求", "source-b"), change("other-policy", "会话中止请求", undefined, "policy-b")]);
    await index.sync("project-b", [{ seq: 1, op: "upsert", id: "other-project", document: { ...document("other-project", "会话中止请求"), projectId: "project-b" } }]);
    assert.deepEqual(await index.search(query("会话中止请求")), ["valid"]);
    const injected = await index.search(query("会话 OR source_key:source-b"));
    assert.ok(!injected.includes("old-source"));
    await assert.rejects(index.search({ ...query("中止"), projectId: "../escape" }), /project|项目/i);
    await index.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("two independent index facades coordinate a publish and query without retained native locks", async () => {
  const Index = await indexClass();
  const dataDir = await mkdtemp(join(tmpdir(), "memory-index-lock-"));
  try {
    const first = new Index({ dataDir });
    const second = new Index({ dataDir });
    await Promise.all([
      first.sync("project-a", [change("first", "源码版本校验")]),
      second.sync("project-a", [change("second", "源码版本校验")]),
    ]);
    assert.deepEqual(new Set(await first.search(query("源码版本"))), new Set(["first", "second"]));
    await Promise.all([first.close(), second.close()]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("independent Node processes persist both native writers under the project lock", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-native-process-"));
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL("../scripts/memory-index-process.ts", import.meta.url));
  const child = (action: string, n: number, suffix?: string) => exec(process.execPath, ["--import", "tsx", script, dataDir, action, String(n), ...(suffix ? [suffix] : [])]);
  try {
    await Promise.all([child("write", 5, "a"), child("write", 5, "b")]);
    await child("verify-writers", 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("rebuilding more than the native batch limit preserves all reviewed documents", async () => {
  const Index = await indexClass();
  const dataDir = await mkdtemp(join(tmpdir(), "memory-native-batch-"));
  try {
    const index = new Index({ dataDir });
    await index.rebuild("project-a", Array.from({ length: 1025 }, (_, i) => document(`entry-${i}`, i === 1024 ? "最后批次独有词" : "第一批次")));
    assert.deepEqual(await index.search(query("独有词")), ["entry-1024"]);
    await index.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
