import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createReadOnlySession } from "./session-factory.js";
import { resolveProject } from "./project-resolver.js";

export interface SessionEntry {
  id: string;
  projectPath: string;
  modelLabel: string;
  session: AgentSession;
  /** 串行队列尾：同一会话同一时刻只允许一个 prompt 运行。 */
  queue: Promise<unknown>;
}

const registry = new Map<string, SessionEntry>();

/**
 * 把任务串行挂到会话队列上：前一个任务（无论成败）结束后再执行下一个。
 * 返回的 Promise 反映本次任务的成败，但队列尾始终吞掉异常以保持链存活。
 */
function enqueue<T>(entry: SessionEntry, task: () => Promise<T>): Promise<T> {
  const run = entry.queue.then(task, task);
  entry.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
}

export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
  const resolved = resolveProject(opts.project);

  // 幂等：已存在的 id 直接返回，便于客户端重试建会话
  if (opts.sessionId) {
    const existing = registry.get(opts.sessionId);
    if (existing) {
      return { id: existing.id, projectPath: existing.projectPath, modelLabel: existing.modelLabel };
    }
  }

  const id = opts.sessionId ?? randomUUID();
  const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
    resume: opts.resume ?? false,
    modelId: opts.modelId,
  });

  registry.set(id, { id, projectPath: resolved.cwd, modelLabel, session, queue: Promise.resolve() });
  return { id, projectPath: resolved.cwd, modelLabel };
}

export function getSession(id: string): SessionEntry | undefined {
  return registry.get(id);
}

export function runOnSession<T>(entry: SessionEntry, task: () => Promise<T>): Promise<T> {
  return enqueue(entry, task);
}

export function closeSession(id: string): boolean {
  const entry = registry.get(id);
  if (!entry) return false;
  entry.session.dispose();
  registry.delete(id);
  return true;
}

export function listSessions(): Array<{ id: string; projectPath: string; modelLabel: string }> {
  return [...registry.values()].map((e) => ({
    id: e.id,
    projectPath: e.projectPath,
    modelLabel: e.modelLabel,
  }));
}
