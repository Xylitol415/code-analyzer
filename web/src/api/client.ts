import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { SseEventName } from "../types";

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  modelLabel: string;
  resumed: boolean;
}

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

export async function createSession(
  config: ServerConfig,
  project: string,
  resume = false,
  modelId?: string,
): Promise<SessionInfo> {
  const body: Record<string, unknown> = { project, resume };
  if (modelId) body.modelId = modelId;
  const res = await fetch(`${config.baseUrl}/sessions`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function listModels(config: ServerConfig): Promise<ModelList> {
  const res = await fetch(`${config.baseUrl}/models`, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
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
      let msg = `HTTP ${response.status}`;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (body.error) msg = body.error;
      }
      throw new Error(msg);
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
