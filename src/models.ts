import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** 缓存一个 ModelRuntime，避免每次 /models 请求重建。 */
let cachedRuntime: ModelRuntime | null = null;

async function getRuntime(): Promise<ModelRuntime> {
  if (!cachedRuntime) cachedRuntime = await ModelRuntime.create();
  return cachedRuntime;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** 默认推荐模型，格式 "provider/id"。 */
  default: string;
}

export async function listModels(): Promise<ModelListResult> {
  const rt = await getRuntime();
  const available = await rt.getAvailable();

  const models: ModelInfo[] = available
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name }))
    .sort((a, b) => {
      // deepseek 排最前，其余按 provider/id 排序
      const aDeep = a.provider === "deepseek" ? 0 : 1;
      const bDeep = b.provider === "deepseek" ? 0 : 1;
      if (aDeep !== bDeep) return aDeep - bDeep;
      return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    });

  // 默认：deepseek-v4-pro > 任意 deepseek > 第一个
  const def =
    models.find((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro") ??
    models.find((m) => m.provider === "deepseek") ??
    models[0];

  return { models, default: def ? `${def.provider}/${def.id}` : "" };
}
