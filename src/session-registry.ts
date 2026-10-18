import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createReadOnlySession } from "./session-factory.js";
import { resolveProject } from "./project-resolver.js";
import { SessionQueue } from "./session-queue.js";
import { parseModelOptions, type SessionModelOptions } from "./llm-config.js";
import { HistoryError, historyMessages, listProjectHistory, validateHistorySelection, type HistoryMessage } from "./session-history.js";
import { getSessionSkills } from "./skills/runtime.js";
import type { SkillSnapshot } from "./skills/types.js";

export interface SessionEntry {
  id: string;
  projectPath: string;
  modelLabel: string;
  historyId: string;
  resumed: boolean;
  session: AgentSession;
  /** 串行执行、取消和关闭状态。 */
  queue: SessionQueue;
}

const registry = new Map<string, SessionEntry>();
// Includes sessions still opening or closing, so no two agent instances write
// to one transcript while asynchronous initialization/cleanup is in progress.
const activeHistory = new Set<string>();
const activeRuntimeIds = new Set<string>();
const historyKey = (projectPath: string, historyId: string) => `${projectPath}\0${historyId}`;

export function isHistoryActive(projectPath: string, historyId: string): boolean {
  return activeHistory.has(historyKey(projectPath, historyId));
}

export function getHistoryActiveSessionId(projectPath: string, historyId: string): string | undefined {
  for (const entry of registry.values()) {
    if (entry.projectPath === projectPath && entry.historyId === historyId) return entry.id;
  }
}

export interface OpenSessionOptions extends SessionModelOptions {
  project: string;
  /** 显式指定会话 id（缺省自动生成 UUID）。 */
  sessionId?: string;
  /** 是否恢复该项目上一次的会话。默认 false（全新）。 */
  resume?: boolean;
  historyId?: string;
}

export interface OpenSessionResult {
  id: string;
  projectPath: string;
  modelLabel: string;
  /** 是否打开已有持久会话；恢复时直接展示 messages，不再自动请求总结。 */
  resumed: boolean;
  historyId: string;
  messages: HistoryMessage[];
  skills: SkillSnapshot["skills"];
  skillsRevision: number;
}

function sessionResult(entry: SessionEntry): OpenSessionResult {
  const snapshot = getSessionSkills(entry.session);
  return {
    // Import previews and turn events use the store's canonical identity.
    // Keep the transcript's original cwd internally for historical compatibility.
    id: entry.id, projectPath: snapshot?.projectPath ?? entry.projectPath, modelLabel: entry.modelLabel,
    historyId: entry.historyId, resumed: entry.resumed,
    messages: entry.resumed ? historyMessages(entry.session.sessionManager.getBranch()) : [],
    skills: snapshot?.skills ?? [],
    skillsRevision: snapshot?.revision ?? 0,
  };
}

export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
  const modelOptions = parseModelOptions(opts);
  validateHistorySelection(opts);
  const resolved = resolveProject(opts.project);

  // 幂等：已存在的 id 直接返回，便于客户端重试建会话
  if (opts.sessionId) {
    const existing = registry.get(opts.sessionId);
    if (existing) {
      if (existing.projectPath !== resolved.cwd ||
          (opts.historyId !== undefined && existing.historyId !== opts.historyId)) {
        throw new HistoryError("该 sessionId 已用于其他项目或历史会话，请使用新的 sessionId", 409);
      }
      return sessionResult(existing);
    }
  }

  const id = opts.sessionId ?? randomUUID();
  if (activeRuntimeIds.has(id)) throw new HistoryError("该 sessionId 正在创建或关闭，请稍后重试", 409);
  activeRuntimeIds.add(id);
  let reservation: string | undefined;
  try {
    const selectedId = opts.historyId ?? (opts.resume ? (await listProjectHistory(resolved.cwd))[0]?.id : undefined);
    if (selectedId) {
      const key = historyKey(resolved.cwd, selectedId);
      if (activeHistory.has(key)) throw new HistoryError("该历史会话正在使用中，请先结束原会话后重试", 409);
      activeHistory.add(key);
      reservation = key;
    }
    const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
      resume: false,
      historyId: selectedId,
      ...modelOptions,
    });
    const historyId = session.sessionManager.getSessionId();
    const resumed = selectedId !== undefined;
    activeHistory.add(historyKey(resolved.cwd, historyId));
    const entry = { id, projectPath: resolved.cwd, modelLabel, historyId, resumed, session, queue: new SessionQueue(session) };
    registry.set(id, entry);
    return sessionResult(entry);
  } catch (error) {
    if (reservation) activeHistory.delete(reservation);
    activeRuntimeIds.delete(id);
    throw error;
  }
}

export function getSession(id: string): SessionEntry | undefined {
  return registry.get(id);
}

export function runOnSession<T>(entry: SessionEntry, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return entry.queue.run(task, signal);
}

export async function closeSession(id: string): Promise<boolean> {
  const entry = registry.get(id);
  if (!entry) return false;
  // Remove immediately so new requests cannot join a session being closed.
  registry.delete(id);
  try {
    await entry.queue.close();
  } finally {
    activeHistory.delete(historyKey(entry.projectPath, entry.historyId));
    activeRuntimeIds.delete(id);
  }
  return true;
}

export function listSessions(): Array<{ id: string; projectPath: string; modelLabel: string }> {
  return [...registry.values()].map((e) => ({
    id: e.id,
    projectPath: e.projectPath,
    modelLabel: e.modelLabel,
  }));
}
