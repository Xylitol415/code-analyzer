import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnswerMetadata, AnswerRecord, SourceSnapshot } from "./memory/types.js";
import { getAgentDir, parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface HistorySessionInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  modelLabel?: string;
  active?: boolean;
  /** Exact runtime connection; absent while a session is opening or closing. */
  activeSessionId?: string;
}

export interface HistoryMessage extends Partial<AnswerMetadata> {
  snapshot?: SourceSnapshot;
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  tools: Array<{ name: string; args?: unknown; isError?: boolean }>;
  streaming: false;
  stopped?: boolean;
  error?: string;
}

export class HistoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "HistoryError";
  }
}

// Old web clients persisted these synthetic turns as ordinary user messages.
// Exact matching preserves real questions that happen to begin similarly.
const AUTOMATIC_PROMPTS = new Set([
  "会话已建立。请用简短友好的中文向用户打个招呼，介绍你是只读的代码逻辑分析助手，能帮他分析项目整体架构、追踪调用链、解释某段代码逻辑、查看代码演进历史等，并邀请他开始提问。不要冗长。",
  "欢迎回来。请用简短的中文总结我们之前讨论过的内容和主要结论，方便用户快速回顾，然后邀请他继续提问。",
]);

export function isAutomaticQuestion(question: string): boolean { return AUTOMATIC_PROMPTS.has(question.trim()); }

export function validateHistorySelection(options: { historyId?: unknown; resume?: unknown; inMemory?: boolean }): void {
  if (options.historyId === undefined) return;
  if (typeof options.historyId !== "string" || options.historyId.length > 128 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.historyId)) {
    throw new HistoryError("historyId 必须是历史列表中的会话 ID", 400);
  }
  if (options.resume || options.inMemory) {
    throw new HistoryError("historyId 不能与 resume 或内存会话同时使用", 400);
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
}

/** Restore the visible branch, including messages preceding SDK compaction. */
export function historyMessages(entries: SessionEntry[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const tools = new Map<string, HistoryMessage["tools"][number]>();
  let assistant: HistoryMessage | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "answer_completed") {
      const record = entry.data as AnswerRecord | undefined;
      if (assistant && record?.id && record.assistantEntryIds?.includes(assistant.id)) {
        Object.assign(assistant, { content: record.answer, answerId: record.id, answerVersion: record.version,
          source: record.source, knowledgeIds: record.knowledgeIds, usage: record.usage, snapshot: record.snapshot });
      }
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      assistant = undefined;
      const content = textContent(message.content);
      if (!isAutomaticQuestion(content)) {
        messages.push({ id: entry.id, role: "user", content, thinking: "", tools: [], streaming: false });
      }
    } else if (message.role === "assistant") {
      if (!assistant) {
        assistant = { id: entry.id, role: "assistant", content: "", thinking: "", tools: [], streaming: false };
        messages.push(assistant);
      }
      for (const block of message.content) {
        if (block.type === "text") assistant.content += block.text;
        else if (block.type === "thinking") assistant.thinking += block.thinking;
        else if (block.type === "toolCall") {
          const tool = { name: block.name, args: block.arguments };
          assistant.tools.push(tool);
          tools.set(block.id, tool);
        }
      }
      assistant.stopped = message.stopReason === "aborted" || undefined;
      assistant.error = message.stopReason === "error" ? message.errorMessage || "模型请求失败" : undefined;
    } else if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      if (tool) tool.isError = message.isError;
    }
  }
  return messages;
}

function matchesProject(cwd: string, projectPath: string): boolean {
  return !!cwd && resolve(cwd) === resolve(projectPath);
}

function sessionDirectory(projectPath: string): string {
  // pi 0.87.1's default-directory helper creates the directory. Passing the
  // same encoded path explicitly keeps discovery entirely read-only.
  const encoded = `--${resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", encoded);
}

export async function listProjectHistory(projectPath: string): Promise<HistorySessionInfo[]> {
  const sessions = await SessionManager.list(projectPath, sessionDirectory(projectPath));
  const result: HistorySessionInfo[] = [];
  for (const info of sessions) {
    // Default SDK directory encoding can collide (slashes and hyphens). Check
    // the header as well rather than trusting membership of that directory.
    if (!matchesProject(info.cwd, projectPath)) continue;
    try {
      const entries = parseSessionEntries(await readFile(info.path, "utf8"));
      const manager = SessionManager.inMemory(projectPath, undefined, entries);
      const branch = manager.getBranch();
      const messages = historyMessages(branch);
      const firstQuestion = messages.find((message) => message.role === "user")?.content;
      let modelLabel: string | undefined;
      for (const entry of branch) {
        if (entry.type === "model_change") modelLabel = `${entry.provider}/${entry.modelId}`;
        else if (entry.type === "message" && entry.message.role === "assistant") {
          modelLabel = `${entry.message.provider}/${entry.message.model}`;
        }
      }
      result.push({
        id: info.id,
        title: (info.name || firstQuestion || "新会话").replace(/\s+/g, " ").trim().slice(0, 120),
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: messages.length,
        modelLabel,
      });
    } catch {
      // A deleted or malformed transcript must not make all history unusable.
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function openHistorySession(projectPath: string, id: string): Promise<SessionManager> {
  validateHistorySelection({ historyId: id });
  const path = SessionManager.findById(projectPath, id, sessionDirectory(projectPath));
  if (!path) throw new HistoryError("该项目下未找到指定历史会话，请刷新列表", 404);
  let entries;
  try {
    entries = parseSessionEntries(await readFile(path, "utf8"));
  } catch {
    throw new HistoryError("历史会话暂时无法读取，请刷新列表", 404);
  }
  const header = entries.find((entry) => entry.type === "session");
  if (!header || header.id !== id || !matchesProject(header.cwd, projectPath)) {
    throw new HistoryError("该项目下未找到指定历史会话，请刷新列表", 404);
  }
  return SessionManager.open(path);
}
