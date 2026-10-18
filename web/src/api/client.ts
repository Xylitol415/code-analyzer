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
): Promise<SessionInfo> {
  const res = await fetch(`${config.baseUrl}/sessions`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ project, resume }),
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
