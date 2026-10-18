/** Per-session OpenAI Chat Completions configuration. Never persist this object. */
export interface CustomLlmConfig {
  baseUrl: string;
  apiKey?: string;
  /** Exact upstream model ID, including any provider/organization prefix. */
  model: string;
}

export interface SessionModelOptions {
  modelId?: string;
  llm?: CustomLlmConfig;
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new LlmConfigError(`${field} 必须是非空字符串，且不能包含控制字符`);
  }
  return value.trim();
}

/** Validate at every entry point; errors only name fields, never their secret values. */
export function parseModelOptions(input: unknown): SessionModelOptions {
  if (!isObject(input)) throw new LlmConfigError("请求体必须是 JSON 对象");
  if (input.llm !== undefined && input.modelId !== undefined) {
    throw new LlmConfigError("llm 与 modelId 不能同时指定");
  }
  if (input.llm === undefined) {
    return input.modelId === undefined ? {} : { modelId: requiredString(input.modelId, "modelId") };
  }
  if (!isObject(input.llm)) throw new LlmConfigError("llm 必须是对象");
  const baseUrl = requiredString(input.llm.baseUrl, "llm.baseUrl").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmConfigError("llm.baseUrl 必须是有效的 HTTP(S) API 根地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmConfigError("llm.baseUrl 必须使用 HTTP(S)，且不能包含用户名、密码、查询参数或片段");
  }
  const model = requiredString(input.llm.model, "llm.model");
  const key = input.llm.apiKey;
  if (key !== undefined && (typeof key !== "string" || /[\x00-\x1f\x7f]/.test(key))) {
    throw new LlmConfigError("llm.apiKey 必须是字符串，且不能包含控制字符");
  }
  return { llm: { baseUrl, model, apiKey: typeof key === "string" ? key.trim() || undefined : undefined } };
}
