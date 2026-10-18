import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createGitReadonlyTool } from "./git-tool.js";
import { getEnvConfig } from "./config.js";

/** 追加到默认系统提示词末尾的「代码逻辑分析」角色说明。 */
const ANALYZER_INSTRUCTIONS = `## 角色：只读代码逻辑分析助手

你正在分析一个 git 项目的代码。你的唯一职责是帮助用户理解代码逻辑，绝不修改任何文件。

### 职责
- 解释整体架构、模块职责与依赖关系
- 追踪数据流、调用链、关键算法与配置
- 定位某个功能/符号的实现位置，说明它如何工作
- 回答关于代码演进（谁改的、为什么改）的问题

### 工作方法
1. 优先用 grep / find 定位符号与关键字，再 read 关键文件，必要时用 git（只读）查看历史与改动。
2. 结论要基于真实代码，引用「文件路径 + 行号/代码片段」作为证据。
3. 不确定时明确说「不确定」，不要臆测。

### 约束（必须遵守）
- 严格只读：本会话只提供 read / grep / find / ls 与只读 git，没有写文件或执行任意命令的能力。
- 回答简洁、结构化；默认使用中文（除非用户要求其他语言）。`;

export interface ReadOnlySessionOptions {
  /** 是否恢复该项目上一次的会话（默认新建）。 */
  resume: boolean;
  /** 覆盖默认模型，格式 "provider/modelId"，例如 "deepseek/deepseek-v4-pro"。 */
  modelId?: string;
  /** 使用内存会话（不落盘），用于一次性提问。默认 false。 */
  inMemory?: boolean;
}

export interface ReadOnlySessionResult {
  session: AgentSession;
  modelLabel: string;
}

/**
 * 为指定项目创建一个严格只读的分析会话。
 * - 工具集：read / grep / find / ls + 自定义只读 git 工具（不含 bash/edit/write）。
 * - 系统提示词：追加代码逻辑分析角色说明。
 * - 会话：按 cwd 持久化，支持 resume。
 * - 模型：显式解析，避免配置里的默认模型 id 失效导致静默失败。
 */
export async function createReadOnlySession(
  projectPath: string,
  options: ReadOnlySessionOptions,
): Promise<ReadOnlySessionResult> {
  const agentDir = getAgentDir();
  const env = getEnvConfig();

  const modelRuntime = await ModelRuntime.create();

  // 确定 provider：优先从显式模型 / 环境变量模型里取，默认 deepseek
  const provider = providerOf(options.modelId ?? env.model) ?? "deepseek";

  // base URL 覆盖：环境变量 / .env 优先（registerProvider 会把 baseUrl 覆盖到该 provider 下所有模型）
  if (env.baseUrl) {
    modelRuntime.registerProvider(provider, { baseUrl: env.baseUrl });
  }

  // API key 注入：环境变量 / .env 优先于 ~/.pi/agent 里的凭据
  if (env.apiKey) {
    await modelRuntime.setRuntimeApiKey(provider, env.apiKey);
  }

  // 模型选择：显式 --model / HTTP modelId 优先，其次环境变量 CODE_ANALYZER_MODEL
  const model = await resolveModel(modelRuntime, options.modelId ?? env.model);

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectPath,
    agentDir,
    appendSystemPromptOverride: (base) => [...base, ANALYZER_INSTRUCTIONS],
  });
  await resourceLoader.reload();

  const sessionManager = options.inMemory
    ? SessionManager.inMemory(projectPath)
    : options.resume
      ? SessionManager.continueRecent(projectPath)
      : SessionManager.create(projectPath);

  const { session } = await createAgentSession({
    cwd: projectPath,
    model,
    modelRuntime,
    tools: ["read", "grep", "find", "ls", "git"],
    customTools: [createGitReadonlyTool(projectPath)],
    resourceLoader,
    sessionManager,
  });

  return { session, modelLabel: `${model.provider}/${model.id}` };
}

/** 从 "provider/modelId" 里提取 provider；无斜杠返回 undefined。 */
function providerOf(modelRef?: string): string | undefined {
  if (!modelRef) return undefined;
  const slash = modelRef.indexOf("/");
  return slash >= 0 ? modelRef.slice(0, slash) : undefined;
}

async function resolveModel(modelRuntime: ModelRuntime, requested?: string) {
  if (requested) {
    const slash = requested.indexOf("/");
    if (slash >= 0) {
      const provider = requested.slice(0, slash);
      const id = requested.slice(slash + 1);
      const m = modelRuntime.getModel(provider, id);
      if (!m) throw new Error(`未找到模型: ${requested}`);
      return m;
    }
    // 仅给出 model id 时，在所有 provider 中查找
    const available = await modelRuntime.getAvailable();
    const m = available.find((x) => x.id === requested);
    if (!m) throw new Error(`未找到模型: ${requested}`);
    return m;
  }

  const available = await modelRuntime.getAvailable();
  if (available.length === 0) {
    throw new Error("没有可用模型，请检查 ~/.pi/agent 的模型与凭据配置");
  }
  // 优先 deepseek 的 pro 模型（代码分析质量更高），其次任意 deepseek，最后退回第一个可用
  return (
    available.find((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro") ??
    available.find((m) => m.provider === "deepseek") ??
    available[0]
  );
}
