import assert from "node:assert/strict";
import test from "node:test";

test("memory REPL commands display actual state, search, bypass and idempotent feedback", async () => {
  const module = await import("../src/memory/commands.js").catch(() => undefined);
  assert.ok(module?.executeMemoryCommand, "REPL memory commands must be implemented");
  const lines: string[] = [];
  const context = {
    projectPath: "/project", policyHash: "policy", clientId: "test-client", lastAnswer: { id: "last-answer" }, write: (line: string) => lines.push(line),
    service: {
      list: async () => ({ total: 2, indexAvailable: true, snapshot: { branch: "main", commit: "abcdef", clean: true } }),
      snapshot: async () => ({ clean: true }),
      search: async () => [{ id: "knowledge", question: "停止请求", answer: "会真正中止模型请求。", conditions: "生成期间" }],
      feedback: async (_id: string, input: { vote: string | null }) => ({ vote: input.vote }),
    },
  };
  assert.equal((await module.executeMemoryCommand("ordinary question", context)).handled, false);
  await module.executeMemoryCommand("/memory", context);
  assert.match(lines.join("\n"), /2/);
  await module.executeMemoryCommand("/memory search 停止", context);
  assert.match(lines.join("\n"), /真正中止模型/);
  assert.deepEqual(await module.executeMemoryCommand("/memory bypass 为什么", context), { handled: true, bypassQuestion: "为什么" });
  await module.executeMemoryCommand("/feedback down incorrect 事实有误", context);
  assert.match(lines.at(-1)!, /保存/);
  await module.executeMemoryCommand("/feedback clear", context);
  assert.match(lines.at(-1)!, /清除/);
  await assert.rejects(module.executeMemoryCommand("/memory bypass", context), /用法/);
  await assert.rejects(module.executeMemoryCommand("/feedback up", { ...context, lastAnswer: undefined }), /回答/);
});
