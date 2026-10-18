import type { EnvConfig } from "./config.js";
import type { CustomLlmConfig } from "./llm-config.js";

export interface CliArgs {
  target?: string;
  resume: boolean;
  modelId?: string;
  llm?: CustomLlmConfig;
  help: boolean;
  noThinking: boolean;
  noColor: boolean;
}

export function parseArgs(argv: string[], env: EnvConfig = {}): CliArgs {
  const out: CliArgs = { resume: true, help: false, noThinking: false, noColor: false };
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--new") {
      out.resume = false;
    } else if (a === "--no-thinking") {
      out.noThinking = true;
    } else if (a === "--no-color") {
      out.noColor = true;
    } else if (["--model", "--base-url", "--api-key"].includes(a.split("=", 1)[0])) {
      const equals = a.indexOf("=");
      const flag = equals >= 0 ? a.slice(0, equals) : a;
      const value = equals >= 0 ? a.slice(equals + 1) : argv[++i];
      if (value === undefined || (equals < 0 && value.startsWith("-"))) {
        throw new Error(`${flag} 需要提供参数值`);
      }
      // 显式空 key 表示本地无鉴权接口，覆盖环境中的 key。
      if (flag !== "--api-key" && !value.trim()) {
        throw new Error(`${flag} 需要提供非空参数值`);
      }
      if (flag === "--model") out.modelId = value.trim();
      if (flag === "--base-url") baseUrl = value.trim();
      if (flag === "--api-key") apiKey = value;
    } else if (a.startsWith("-")) {
      // 不回显未知参数；参数中可能包含误填的凭据。
      throw new Error("存在未知参数，请使用 --help 查看支持的选项");
    } else if (!out.target) {
      out.target = a;
    } else {
      throw new Error("只能指定一个项目路径或 URL");
    }
  }

  if (baseUrl !== undefined) {
    const model = out.modelId ?? env.model?.trim();
    if (!model) throw new Error("--base-url 需要同时通过 --model 或 CODE_ANALYZER_MODEL 指定模型名");
    out.llm = { baseUrl, model, apiKey: apiKey ?? env.apiKey };
    delete out.modelId;
  } else if (apiKey !== undefined) {
    throw new Error("--api-key 需要同时提供 --base-url；已有模型的凭据请使用 CODE_ANALYZER_API_KEY");
  }
  return out;
}
