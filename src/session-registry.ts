import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createReadOnlySession } from "./session-factory.js";
import { resolveProject } from "./project-resolver.js";
import { SessionQueue } from "./session-queue.js";

export interface SessionEntry {
  id: string;
  projectPath: string;
  modelLabel: string;
  session: AgentSession;
  /** 串行执行、取消和关闭状态。 */
  queue: SessionQueue;
}

const registry = new Map<string, SessionEntry>();

export interface OpenSessionOptions {
  project: string;
  /** 显式指定会话 id（缺省自动生成 UUID）。 */
  sessionId?: string;
  /** 是否恢复该项目上一次的会话。默认 false（全新）。 */
  resume?: boolean;
  modelId?: string;
}

export interface OpenSessionResult {
  id: string;
  projectPath: string;
  modelLabel: string;
  /** 是否恢复到了已有历史会话（用于前端决定「打招呼」还是「总结」）。 */
  resumed: boolean;
}

export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
  const resolved = resolveProject(opts.project);

  // 幂等：已存在的 id 直接返回，便于客户端重试建会话
  if (opts.sessionId) {
    const existing = registry.get(opts.sessionId);
    if (existing) {
      return { id: existing.id, projectPath: existing.projectPath, modelLabel: existing.modelLabel, resumed: false };
    }
  }

  const id = opts.sessionId ?? randomUUID();
  const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
    resume: opts.resume ?? false,
    modelId: opts.modelId,
  });

  // resume 且恢复到了含历史用户消息的会话，才算真正的「恢复」
  const resumed = (opts.resume ?? false) && session.messages.some((m) => m.role === "user");

  registry.set(id, { id, projectPath: resolved.cwd, modelLabel, session, queue: new SessionQueue(session) });
  return { id, projectPath: resolved.cwd, modelLabel, resumed };
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
  await entry.queue.close();
  return true;
}

export function listSessions(): Array<{ id: string; projectPath: string; modelLabel: string }> {
  return [...registry.values()].map((e) => ({
    id: e.id,
    projectPath: e.projectPath,
    modelLabel: e.modelLabel,
  }));
}
