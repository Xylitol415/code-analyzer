import type { PendingSessionMessage, SessionMessageState, FeedbackInput, FeedbackResult, KnowledgeItem, MemoryLibrary, ReviewInput } from "../types";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatMessage, SseEventName, SkillLibrary, SkillPreview, SkillSnapshot, SkillConfirmation } from "../types";

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
  skills?: SkillSnapshot["skills"];
  skillsRevision?: number;
}

export interface HistorySessionInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  modelLabel?: string;
  active?: boolean;
  activeSessionId?: string;
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
  options?: { requestId?: string; reuse?: "auto" | "bypass"; mode?: "followUp" },
): Promise<void> {
  return fetchEventSource(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/ask`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ question, ...options }),
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


export async function getSessionMessages(config: ServerConfig, sessionId: string, signal?: AbortSignal): Promise<SessionMessageState> {
  const response = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`, { headers: authHeaders(config), signal });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export interface SessionMessageResult {
  message: PendingSessionMessage;
  state: SessionMessageState;
}

export async function steerSession(config: ServerConfig, sessionId: string, input: { question: string; requestId: string; targetRequestId: string }): Promise<SessionMessageResult> {
  const response = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST", headers: authHeaders(config), body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function cancelSessionMessage(config: ServerConfig, sessionId: string, messageId: string): Promise<SessionMessageResult> {
  const response = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE", headers: authHeaders(config),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}


export async function listSkills(config: ServerConfig, project: string): Promise<SkillLibrary> {
  const response = await fetch(`${config.baseUrl}/skills?project=${encodeURIComponent(project)}`, {
    headers: authHeaders(config),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function prepareSkillImport(
  config: ServerConfig, project: string, input: { file: File } | { url: string } | { localId: string },
): Promise<SkillPreview> {
  let body: FormData | string;
  let headers: Record<string, string>;
  if ("file" in input) {
    body = new FormData();
    body.set("project", project);
    body.set("file", input.file);
    // The browser supplies the multipart boundary.
    headers = { Authorization: `Bearer ${config.token}` };
  } else {
    body = JSON.stringify({ project, ...input });
    headers = authHeaders(config);
  }
  const response = await fetch(`${config.baseUrl}/skills/imports`, { method: "POST", headers, body });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function confirmSkillImport(config: ServerConfig, previewId: string): Promise<SkillConfirmation> {
  const response = await fetch(`${config.baseUrl}/skills/imports/${encodeURIComponent(previewId)}/confirm`, {
    method: "POST", headers: authHeaders(config), body: "{}",
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function patchSkill(
  config: ServerConfig, project: string, id: string, enabled: boolean, version?: string,
): Promise<SkillSnapshot> {
  const response = await fetch(`${config.baseUrl}/skills/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: authHeaders(config), body: JSON.stringify({ project, enabled, ...(version ? { version } : {}) }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}


export async function listKnowledge(config: ServerConfig, project: string, state = "candidate", limit = 20, offset = 0): Promise<MemoryLibrary> {
  return memoryRequest(config, `/memory/knowledge?project=${encodeURIComponent(project)}&state=${encodeURIComponent(state)}&limit=${limit}&offset=${offset}`);
}
export async function getKnowledge(config: ServerConfig, id: string): Promise<KnowledgeItem> {
  return memoryRequest(config, `/memory/knowledge/${encodeURIComponent(id)}`);
}
export async function collectAnswer(config: ServerConfig, answerId: string): Promise<KnowledgeItem> {
  return memoryRequest(config, "/memory/knowledge", "POST", { answerId });
}
export async function putFeedback(config: ServerConfig, answerId: string, input: FeedbackInput): Promise<FeedbackResult> {
  return memoryRequest(config, `/memory/answers/${encodeURIComponent(answerId)}/feedback`, "PUT", input);
}
export async function getFeedback(config: ServerConfig, answerId: string, clientId: string): Promise<FeedbackResult> {
  return memoryRequest(config, `/memory/answers/${encodeURIComponent(answerId)}/feedback?clientId=${encodeURIComponent(clientId)}`);
}
export async function previewKnowledgeEvidence(config: ServerConfig, id: string, input: { expectedRevision: number; expectedSourceKey: string; evidence: import("../types").SourceEvidenceInput[] }): Promise<{ snapshot: import("../types").SourceSnapshot; evidence: import("../types").SourceEvidence[] }> {
  return memoryRequest(config, `/memory/knowledge/${encodeURIComponent(id)}/evidence`, "POST", input);
}
export async function reviewKnowledge(config: ServerConfig, id: string, input: ReviewInput): Promise<KnowledgeItem> {
  return memoryRequest(config, `/memory/knowledge/${encodeURIComponent(id)}/review`, "POST", input);
}
async function memoryRequest<T>(config: ServerConfig, path: string, method = "GET", input?: unknown): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method, headers: authHeaders(config), ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
