import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AnswerRecord, FeedbackReason, MemoryService } from "./types.js";

export function replFeedbackClientId(): string {
  const directory = resolve(process.env.CODE_ANALYZER_DATA_DIR ?? join(homedir(), ".code-analyzer"), "memory");
  const path = join(directory, "repl-client-id");
  const id = randomUUID();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { writeFileSync(path, id, { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const saved = readFileSync(path, "utf8").trim();
    return /^[0-9a-f-]{36}$/.test(saved) ? saved : id;
  } catch { return id; }
}

export async function executeMemoryCommand(line: string, context: {
  projectPath: string; policyHash: string; clientId: string;
  lastAnswer?: Pick<AnswerRecord, "id">;
  service: Pick<MemoryService, "list" | "snapshot" | "search" | "feedback">;
  write(line: string): void;
}): Promise<{ handled: boolean; bypassQuestion?: string }> {
  if (!/^\/(?:memory|feedback)(?:\s|$)/.test(line)) return { handled: false };
  if (line.startsWith("/feedback")) {
    if (!context.lastAnswer) throw new Error("还没有可反馈的已完成回答。");
    const [, vote, reason, comment] = /^\/feedback\s+(up|down|clear)(?:\s+(incorrect|outdated|irrelevant|presentation))?(?:\s+([\s\S]*))?$/.exec(line.trim()) ?? [];
    if (!vote) throw new Error("用法: /feedback up|down|clear [incorrect|outdated|irrelevant|presentation] [说明]");
    await context.service.feedback(context.lastAnswer.id, { clientId: context.clientId, vote: vote === "clear" ? null : vote as "up" | "down", ...(vote === "down" && reason ? { reason: reason as FeedbackReason } : {}), ...(comment ? { comment } : {}) });
    context.write(vote === "clear" ? "反馈已清除。" : "匿名反馈已保存；点赞只生成待审核候选。");
    return { handled: true };
  }
  const [, command = "status", argument = ""] = /^\/memory(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line.trim()) ?? [];
  if (command === "bypass") {
    if (!argument.trim()) throw new Error("用法: /memory bypass <问题>");
    return { handled: true, bypassQuestion: argument.trim() };
  }
  if (command === "status") {
    const result = await context.service.list(context.projectPath);
    context.write(`项目知识 ${result.total} 条；全文索引${result.indexAvailable ? "可用" : "不可用"}；代码 ${result.snapshot.branch}@${result.snapshot.commit.slice(0, 12)}${result.snapshot.clean ? "" : "（工作区有修改，暂停复用）"}。`);
  } else if (command === "search") {
    if (!argument.trim()) throw new Error("用法: /memory search <问题>");
    const snapshot = await context.service.snapshot(context.projectPath);
    if (!snapshot.clean) context.write("当前源码状态不适用知识复用。请清理工作区或重新分析。");
    else {
      const items = await context.service.search({ snapshot, policyHash: context.policyHash, question: argument.trim(), limit: 5 });
      context.write(items.map(item => `${item.question}\n${item.answer}\n适用条件：${item.conditions}\n知识 ID：${item.id}`).join("\n\n") || "没有找到当前源码版本下适用的已发布知识。");
    }
  } else throw new Error("支持: /memory [status] | search <问题> | bypass <问题>");
  return { handled: true };
}
