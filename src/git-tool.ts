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

// Positive argument grammar: rejecting only a few dangerous prefixes misses
// mutations such as `branch new`, `stash pop`, and abbreviated long options.
const COMMON = /^(--(oneline|all|branches|tags|remotes|decorate(?:=(?:short|full|no|auto))?|no-decorate|graph|first-parent|no-merges|merges|reverse|date-order|topo-order|boundary|left-right|cherry-pick|cherry-mark|full-history|simplify-merges|follow|root|exit-code|quiet|name-only|name-status|stat(?:=\d+(?:,\d+)*)?|numstat|shortstat|summary|raw|patch|no-patch|no-renames|find-renames(?:=\d+%?)?|find-copies(?:=\d+%?)?|ignore-all-space|ignore-space-change|ignore-space-at-eol|ignore-blank-lines|word-diff(?:=(?:plain|color|porcelain|none))?|no-color|color=never|relative(?:=.*)?|abbrev(?:=\d+)?|no-abbrev|parents|children|count|header|pretty=.+|format=.+|date=.+|since=.+|until=.+|author=.+|committer=.+|grep=.+|encoding=.+|diff-filter=[ACDMRTUXB*]+|max-count=\d+|skip=\d+|unified=\d+|no-ext-diff|no-textconv)|-[0-9]+|-[npuswWMCR](?:\d+%?)?|-[UG]\S+|-[S]\S+)$/;
const FLAGS: Record<string, RegExp> = {
  status: /^(--(short|branch|porcelain(?:=v?[12])?|untracked-files(?:=(?:no|normal|all))?|ignored(?:=(?:traditional|matching|no))?|ignore-submodules(?:=(?:none|untracked|dirty|all))?|ahead-behind|no-ahead-behind)|-[sbz])$/,
  branch: /^(--(list|all|remotes|verbose|no-color|color=never|show-current|contains(?:=.+)?|no-contains(?:=.+)?|merged(?:=.+)?|no-merged(?:=.+)?|points-at=.+|format=.+|sort=.+|ignore-case)|-[arv]+)$/,
  tag: /^(--(list|no-color|color=never|contains(?:=.+)?|no-contains(?:=.+)?|merged(?:=.+)?|no-merged(?:=.+)?|points-at=.+|format=.+|sort=.+|ignore-case)|-l|-n\d*)$/,
  remote: /^(--verbose|-v)$/,
  "ls-files": /^(--(cached|deleted|modified|others|ignored|stage|unmerged|killed|exclude-standard|full-name|error-unmatch|debug|eol|deduplicate)|-[cdmostukz])$/,
  "ls-tree": /^(--(name-only|name-status|full-name|full-tree|long|abbrev=\d+)|-[rdltz])$/,
  "cat-file": /^-[ptse]$/,
  "rev-parse": /^(--(verify|quiet|short(?:=\d+)?|abbrev-ref(?:=(?:strict|loose))?|symbolic|symbolic-full-name|all|branches(?:=.+)?|tags(?:=.+)?|remotes(?:=.+)?|show-toplevel|show-prefix|show-cdup|git-dir|absolute-git-dir|git-common-dir|is-inside-work-tree|is-bare-repository|show-object-format)|-q)$/,
  describe: /^(--(all|tags|always|long|first-parent|contains|exact-match|abbrev=\d+|candidates=\d+|match=.+|exclude=.+|dirty(?:=.+)?|broken(?:=.+)?))$/,
  grep: /^(--(cached|no-index|untracked|exclude-standard|no-exclude-standard|ignore-case|word-regexp|line-regexp|fixed-strings|extended-regexp|basic-regexp|perl-regexp|line-number|column|files-with-matches|files-without-match|count|all-match|and|or|not|break|heading|no-heading|no-color|color=never)|-[niwvlLchEFGP]|-[ABC]\d+|-e)$/,
  blame: /^(--(line-porcelain|porcelain|incremental|show-email|show-name|show-number|root|first-parent|ignore-rev=.+|contents=-)|-[wsplfen]|-L.+|-M\d*|-C\d*)$/,
  "name-rev": /^(--(name-only|tags|all|always|no-undefined|refs=.+|exclude=.+))$/,
  "for-each-ref": /^(--(format=.+|sort=.+|count=\d+|points-at=.+|contains=.+|no-contains=.+|merged=.+|no-merged=.+|ignore-case))$/,
  "count-objects": /^(--(verbose|human-readable)|-[vH])$/,
};

/** shell 元字符，防止参数注入。 */
const SHELL_META = /[;&|`$<>\\\n\r]/;

const MAX_OUTPUT = 20_000;

/** Exported for boundary tests; returns the exact read-only argv to execute. */
export function readonlyGitArgs(command: string, args: string[]): string[] {
  if (!READONLY_SUBCOMMANDS.has(command)) throw new Error(`不允许的 git 子命令：${command}`);
  let mode = command;
  let rest = args;
  const prefix: string[] = [];
  if (command === "stash") {
    mode = args[0] ?? "";
    if (mode !== "list" && mode !== "show") throw new Error("stash 仅允许 list / show 查询");
    prefix.push(mode);
    rest = args.slice(1);
    mode = "log";
  } else if (command === "reflog") {
    if (args[0] === "show") rest = args.slice(1);
    else if (args[0] && !args[0].startsWith("-") && /^(expire|delete|drop|write|exists|list)$/.test(args[0])) {
      throw new Error("reflog 仅允许 show 查询");
    }
    prefix.push("show");
    mode = "log";
  } else if (command === "branch" || command === "tag") {
    if (args.some((a) => !a.startsWith("-")) && !args.includes("--list") && !args.includes("-l")) {
      throw new Error(`${command} 匹配名称时必须显式使用 --list`);
    }
    if (!args.includes("--show-current")) prefix.push("--list");
  }
  let paths = false;
  for (const arg of rest) {
    if (typeof arg !== "string" || SHELL_META.test(arg) || arg.includes("\0")) throw new Error("参数包含危险字符");
    if (arg === "--") { paths = true; continue; }
    if (paths) continue;
    if (arg.startsWith("-")) {
      const grammar = FLAGS[mode] ?? COMMON;
      if (!grammar.test(arg)) throw new Error(`不允许的 git ${command} 参数：${arg}`);
      if (/^--(?:format|pretty)=/.test(arg) && (/%[+ -]?G/.test(arg) || /%\(\*?signature(?::|\))/.test(arg))) {
        throw new Error("不允许触发外部签名验证程序的格式参数");
      }
      if (/^--sort=-?\*?signature(?::|$)/.test(arg)) throw new Error("不允许触发外部签名验证程序的排序参数");
      if (/^--(?:format|pretty)=/.test(arg) && !["branch", "tag", "for-each-ref"].includes(command)) {
        const format = arg.slice(arg.indexOf("=") + 1);
        if (!format.includes("%") && !/^(?:t?format):/.test(format)) {
          throw new Error("不允许命名 pretty 别名；请使用 --oneline 或 --format=tformat:格式");
        }
      }
    } else if (command === "remote" || mode === "count-objects") {
      throw new Error(`${command} 不接受此参数：${arg}`);
    }
  }
  if (command === "remote" && rest.includes("--")) throw new Error("remote 仅允许无参数或 -v 查询");
  const safeDiff = ["diff", "show", "log", "reflog", "stash", "whatchanged"].includes(command)
    ? ["--no-ext-diff", "--no-textconv"] : [];
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
    "-c", "log.showSignature=false", "-c", "format.pretty=tformat:%h %s", "-c", "diff.submodule=short",
    command, ...prefix, ...safeDiff, ...rest];
}

const gitEnvironment = () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" });

/** Git converts working-tree files even in diff/blame. Neutralize every
 * configured filter driver before querying; reading configuration executes no
 * filter. Do not expose command values or invoke a fallback helper. */
export function readonlyGitInvocation(cwd: string, command: string, args: string[]): string[] {
  const safe = readonlyGitArgs(command, args);
  let names = "";
  try {
    names = execFileSync("git", ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], {
      cwd, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000, env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw new Error("无法安全读取 Git filter 配置，已拒绝执行查询");
  }
  const overrides: string[] = [];
  const drivers = new Set(names.split("\0").filter(Boolean).map((name) => {
    const match = /^filter\.(.+)\.[^.]+$/s.exec(name);
    if (!match) throw new Error("Git filter 配置名称无效，已拒绝执行查询");
    return match[1];
  }));
  for (const driver of drivers) {
    for (const option of ["clean", "smudge", "process"]) overrides.push("-c", `filter.${driver}.${option}=`);
    overrides.push("-c", `filter.${driver}.required=false`);
  }
  return [...overrides, ...safe];
}

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

      const args = params.args ?? [];

      try {
        const out = execFileSync("git", readonlyGitInvocation(cwd, sub, args), {
          cwd,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          env: gitEnvironment(),
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
