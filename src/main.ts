import { createReadOnlySession } from "./session-factory.js";
import { resolveProject, resolveProjectForHistory } from "./project-resolver.js";
import { startRepl } from "./repl.js";
import { parseArgs } from "./cli-args.js";
import { getEnvConfig } from "./config.js";
import { parseModelOptions } from "./llm-config.js";
import { listProjectHistory } from "./session-history.js";
import { chooseStartupSession, formatSessionHistory } from "./session-picker.js";

function printHelp(): void {
  console.log(`
code-analyzer —— 只读的代码逻辑分析助手（基于 pi SDK）

用法:
  npm start -- <项目路径|git URL> [--new | --resume | --session <ID>] [--model provider/modelId]
  npm start -- <项目路径|git URL> --list-sessions
  npm start -- <项目路径|git URL> --base-url <URL> --model <模型名> [--api-key <key>]

参数:
  <路径或 URL>   本地 git 仓库路径，或远程 git URL（自动 clone 到缓存目录）
  --new          直接新建会话，跳过启动选择
  --resume       直接恢复该项目最近一次的会话
  --session      恢复指定历史会话 ID（通过 --list-sessions 查看）
  --list-sessions 列出该项目历史会话并退出，无需配置模型凭据
  --model        已有模型的 provider/id，或自定义接口的完整模型名
  --base-url     使用自定义 OpenAI Chat Completions 兼容接口（API 根路径，通常以 /v1 结尾）
  --api-key      自定义接口凭据；默认读取 CODE_ANALYZER_API_KEY，--api-key= 表示无鉴权
  --no-thinking  隐藏模型的思考过程（reasoning）
  --no-color     关闭彩色输出
  --help         显示本帮助

不指定会话参数：交互终端先选择新建或历史会话；非交互环境直接新建。

示例:
  npm start -- ./my-repo
  npm start -- https://github.com/user/repo.git
  npm start -- ./my-repo --new
  npm start -- ./my-repo --list-sessions
  npm start -- ./my-repo --session <会话ID>
  npm start -- ./my-repo --base-url http://127.0.0.1:11434/v1 --model qwen3 --api-key=
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), getEnvConfig());

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.target) {
    printHelp();
    process.exit(1);
  }

  if (args.listSessions) {
    const project = resolveProjectForHistory(args.target);
    console.log(`目标项目: ${project}`);
    process.stdout.write(formatSessionHistory(await listProjectHistory(project)));
    return;
  }

  let resolved;
  try {
    resolved = resolveProject(args.target);
  } catch (e) {
    console.error("错误：" + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  if (args.noColor) process.env.NO_COLOR = "1";

  console.log(`目标项目: ${resolved.cwd}`);
  if (resolved.cloned) console.log(`已 clone: ${resolved.source}`);

  let sessionOptions = { resume: args.resume, historyId: args.historyId };
  if (!args.newSession && !args.resume && !args.historyId && process.stdin.isTTY && process.stdout.isTTY) {
    const choice = await chooseStartupSession(await listProjectHistory(resolved.cwd));
    if (choice === null) return;
    sessionOptions = { resume: choice.resume, historyId: choice.historyId };
  }

  const modelOptions = parseModelOptions(args);
  console.log(`会话模式: ${sessionOptions.historyId ? "恢复选中的历史会话" : sessionOptions.resume ? "恢复上次会话" : "全新会话"}`);

  const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
    ...sessionOptions,
    ...modelOptions,
  });

  console.log(`模型: ${modelLabel}`);
  console.log(`会话 ID: ${session.sessionManager.getSessionId()}`);
  if (session.messages.length) console.log(`已恢复 ${session.messages.length} 条历史消息，可继续追问。`);
  console.log("可用工具: " + session.getActiveToolNames().join(", "));
  if (args.noThinking) console.log("思考过程: 已隐藏");
  console.log("输入问题开始分析；输入 exit / quit 退出。\n");

  await startRepl(session, { showThinking: !args.noThinking });
}

main().catch((e) => {
  console.error("未捕获错误：" + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
