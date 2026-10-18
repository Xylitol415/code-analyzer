import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 固定加载项目根目录的 .env（而不是依赖 process.cwd()），这样无论从哪个目录启动都能找到。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(projectRoot, ".env"), quiet: true });

// 注意：dotenv 默认不覆盖已存在的 process.env，因此优先级天然是：系统环境变量 > .env 文件。

export interface EnvConfig {
  /** API key，应用于所选模型的 provider。 */
  apiKey?: string;
  /** 模型选择，格式 "provider/modelId" 或 "modelId"。 */
  model?: string;
  /** 可选：覆盖 API base URL。 */
  baseUrl?: string;
}

export function getEnvConfig(): EnvConfig {
  return {
    apiKey: process.env.CODE_ANALYZER_API_KEY || undefined,
    model: process.env.CODE_ANALYZER_MODEL || undefined,
    baseUrl: process.env.CODE_ANALYZER_BASE_URL || undefined,
  };
}
