import { createReadOnlySession } from "./session-factory.js";
import { resolveProject } from "./project-resolver.js";
import { startRepl } from "./repl.js";

interface CliArgs {
  target?: string;
  resume: boolean;
  modelId?: string;
  help: boolean;
  noThinking: boolean;
  noColor: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { resume: true, help: false, noThinking: false, noColor: false };
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
    } else if (a === "--model") {
      out.modelId = argv[++i];
    } else if (a.startsWith("--model=")) {
      out.modelId = a.slice("--model=".length);
    } else if (a.startsWith("--")) {
      // 忽略未知开关
    } else if (!out.target) {
      out.target = a;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
code-analyzer —— 只读的代码逻辑分析助手（基于 pi SDK）

用法:
  npm start -- <项目路径|git URL> [--new] [--model provider/modelId]

参数:
  <路径或 URL>   本地 git 仓库路径，或远程 git URL（自动 clone 到缓存目录）
  --new          强制开启全新会话（默认恢复该项目上一次的会话）
  --model        覆盖默认模型，例如 --model deepseek/deepseek-v4-pro
  --no-thinking  隐藏模型的思考过程（reasoning）
  --no-color     关闭彩色输出
  --help         显示本帮助

示例:
  npm start -- ./my-repo
  npm start -- https://github.com/user/repo.git
  npm start -- ./my-repo --new
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.target) {
    printHelp();
    process.exit(1);
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
  console.log(`会话模式: ${args.resume ? "恢复上次会话" : "全新会话"}`);

  const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
    resume: args.resume,
    modelId: args.modelId,
  });

  console.log(`模型: ${modelLabel}`);
  console.log("可用工具: " + session.getActiveToolNames().join(", "));
  if (args.noThinking) console.log("思考过程: 已隐藏");
  console.log("输入问题开始分析；输入 exit / quit 退出。\n");

  await startRepl(session, { showThinking: !args.noThinking });
}

main().catch((e) => {
  console.error("未捕获错误：" + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
