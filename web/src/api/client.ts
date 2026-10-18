import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatMessage, SseEventName } from "../types";

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  modelLabel: string;
  resumed: boolean;
  historyId?: string;
  messages?: ChatMessage[];
}

export interface HistorySessionInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  modelLabel?: string;
  active?: boolean;
}

export interface HistoryList {
  projectPath: string;
  sessions: HistorySessionInfo[];
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

// Keep the existing model ID argument while making custom configuration exclusive.
export type SessionModel = string | { llm: LlmConfig };

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ModelList {
  models: ModelInfo[];
  default: string;
}

function authHeaders(config: ServerConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.token}`,
  };
}

async function responseError(response: Response): Promise<Error> {
  if (response.status === 401) {
    return new Error("后端鉴权失败（401）：请核对后端地址，并填写该服务启动时的 Token（--token 参数或启动日志）。后端 Token 与 LLM API Key 是不同凭据。");
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${response.status}`);
}

export async function createSession(
  config: ServerConfig,
  project: string,
  resume = false,
  model?: SessionModel,
  historyId?: string,
): Promise<SessionInfo> {
  const body: Record<string, unknown> = { project, resume };
  if (historyId) body.historyId = historyId;
  if (typeof model === "string" && model) body.modelId = model;
  else if (model && typeof model === "object") body.llm = model.llm;
  const res = await fetch(`${config.baseUrl}/sessions`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return res.json();
}

export async function deleteSession(config: ServerConfig, sessionId: string): Promise<void> {
  const res = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: authHeaders(config),
    keepalive: true,
  });
  // Releasing a session is idempotent, including after a server restart.
  if (!res.ok && res.status !== 404) {
    throw await responseError(res);
  }
}

export async function listModels(config: ServerConfig): Promise<ModelList> {
  const res = await fetch(`${config.baseUrl}/models`, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return res.json();
}

export async function listHistory(config: ServerConfig, project: string): Promise<HistoryList> {
  const res = await fetch(`${config.baseUrl}/history?project=${encodeURIComponent(project)}`, {
    headers: authHeaders(config),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * 以 SSE 流式向会话提问。事件名：thinking / tool / text / done / error。
 * 用 fetchEventSource 实现 POST + SSE（原生 EventSource 只支持 GET）。
 */
export function askStream(
  config: ServerConfig,
  sessionId: string,
  question: string,
  signal: AbortSignal,
  onEvent: (event: SseEventName, data: unknown) => void,
): Promise<void> {
  return fetchEventSource(`${config.baseUrl}/sessions/${sessionId}/ask`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ question }),
    signal,
    openWhenHidden: true,
    async onopen(response) {
      const ct = response.headers.get("content-type") ?? "";
      if (response.ok && ct.includes("text/event-stream")) return;
      throw await responseError(response);
    },
    onmessage(ev) {
      const data = ev.data ? (JSON.parse(ev.data) as unknown) : {};
      onEvent(ev.event as SseEventName, data);
    },
    onclose() {},
    onerror(err) {
      throw err;
    },
  });
}
