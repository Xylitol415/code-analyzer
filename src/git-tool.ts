import { execFileSync } from "node:child_process";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 只读 git 子命令白名单。 */
const READONLY_SUBCOMMANDS = new Set<string>([
  "log",
  "blame",
  "diff",
  "status",
  "branch",
  "show",
  "shortlog",
  "ls-files",
  "rev-parse",
  "remote",
  "describe",
  "tag",
  "stash",
  "grep",
  "ls-tree",
  "cat-file",
  "name-rev",
  "reflog",
  "for-each-ref",
  "whatchanged",
  "count-objects",
  "rev-list",
]);

/** 可能产生副作用或执行外部程序的 git 参数前缀。 */
const FORBIDDEN_FLAG =
  /^(--output|-o|--exec|--upload-pack|--receive-pack|-c|--config|--template|--work-tree|--git-dir|--namespace|--super-prefix|--pager|--no-pager)/;

/** shell 元字符，防止参数注入。 */
const SHELL_META = /[;&|`$<>\\\n\r]/;

const MAX_OUTPUT = 20_000;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * 注册一个严格只读的 git 查询工具。
 * 关闭对 cwd 的引用，避免依赖运行时的上下文对象。
 */
export function createGitReadonlyTool(cwd: string) {
  return defineTool({
    name: "git",
    label: "Git (只读)",
    description:
      "在项目仓库内执行只读 git 查询，用于理解代码演进、定位改动、查看提交历史。" +
      "可用子命令：" +
      [...READONLY_SUBCOMMANDS].sort().join(", ") +
      "。任何会修改仓库、写文件或执行外部程序的用法都会被拒绝。",
    promptSnippet:
      "git <subcommand> [args...] —— 只读 git 查询（log/blame/diff/status/branch/show 等）",
    parameters: Type.Object({
      command: Type.String({
        description: "只读 git 子命令，例如 log、blame、diff、status、branch、show",
      }),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description: "传给子命令的参数，例如 ['--oneline', '-5'] 或 ['HEAD~3..HEAD']",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const sub = (params.command ?? "").trim();
      if (!READONLY_SUBCOMMANDS.has(sub)) {
        return ok(
          `错误：不允许的 git 子命令 "${sub}"。仅允许只读子命令：${[...READONLY_SUBCOMMANDS]
            .sort()
            .join(", ")}`,
        );
      }

      const args = (params.args ?? []).map((a) => String(a));
      for (const a of args) {
        if (SHELL_META.test(a)) {
          return ok(`错误：参数包含危险字符，已拒绝：${JSON.stringify(a)}`);
        }
        if (FORBIDDEN_FLAG.test(a)) {
          return ok(`错误：参数被禁止（可能产生副作用或执行外部程序）：${JSON.stringify(a)}`);
        }
      }

      try {
        const out = execFileSync("git", [sub, ...args], {
          cwd,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        });
        const text =
          out.length > MAX_OUTPUT
            ? out.slice(0, MAX_OUTPUT) + "\n…（输出过长已截断）"
            : out;
        return ok(text || "(空输出)");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return ok(`错误：git ${sub} ${args.join(" ")} 执行失败：${msg}`);
      }
    },
  });
}
