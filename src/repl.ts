import readline from "node:readline";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runAsk } from "./ask.js";
import { getSessionSkills } from "./skills/runtime.js";
import type { SkillService } from "./skills/service.js";
import type { SkillPreview } from "./skills/types.js";
import { getSessionMemory, sessionPolicyHash } from "./memory/runtime.js";
import { executeMemoryCommand, replFeedbackClientId } from "./memory/commands.js";

export interface SkillsCommandContext {
  projectPath: string;
  service: Pick<SkillService, "list" | "prepare" | "patch" | "confirm">;
  pending: Map<string, SkillPreview>;
  write(line: string): void;
}

export function describeSkillPreview(preview: SkillPreview): string {
  return [
    `Skill 预览 ${preview.id}: ${preview.skill.name} @ ${preview.skill.version}`,
    `描述: ${preview.skill.description}`,
    `项目: ${preview.projectPath}`,
    `来源 (${preview.skill.source.kind}): ${preview.skill.source.label}`,
    `到期: ${preview.expiresAt}`,
    ...(preview.replacement ? [`替换: ${preview.replacement.name} @ ${preview.replacement.version}（旧版本资源保留）`] : []),
    ...(preview.skill.disableModelInvocation ? ["仅显式调用，不向模型自动展示技能摘要。"] : []),
    `文件 (${preview.skill.files.length}):`,
    ...preview.skill.files.map((file) => `  ${file.path} (${file.size} B)`),
    ...preview.warnings,
    `确认导入: /skills confirm ${preview.id}`,
  ].join("\n");
}

/** Host-only commands. Neither confirmation nor toggles are exposed as agent tools. */
export async function executeSkillsCommand(line: string, context: SkillsCommandContext): Promise<boolean> {
  if (!/^\/skills(?:\s|$)/.test(line)) return false;
  const match = /^\/skills(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line.trim());
  const command = match?.[1] ?? "list";
  const argument = (match?.[2] ?? "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  const { service, projectPath, write, pending } = context;
  if (command === "list") {
    const library = await service.list(projectPath);
    write(library.installed.map((skill) => `${skill.enabled ? "[启用]" : "[禁用]"} ${skill.name} (${skill.id}) @ ${skill.version}`).join("\n") || "当前项目尚未导入 Skill。");
    if (library.local.length) write("可导入的本地 Skill:\n" + library.local.map((skill) => `${skill.name}: local:${skill.localId} (${skill.source})`).join("\n"));
  } else if (command === "import") {
    if (!argument) throw new Error("用法: /skills import <HTTPS URL | 文件路径 | local:候选ID>");
    const preview = await service.prepare(projectPath, argument.startsWith("https://")
      ? { kind: "url", url: argument }
      : argument.startsWith("local:") ? { kind: "local", localId: argument.slice(6) }
      : { kind: "path", path: argument });
    pending.set(preview.id, preview);
    write(describeSkillPreview(preview));
  } else if (command === "enable" || command === "disable") {
    if (!argument) throw new Error(`用法: /skills ${command} <名称或ID>`);
    const library = await service.list(projectPath);
    const matches = library.installed.filter((skill) => skill.id === argument || skill.name === argument);
    if (new Set(matches.map((skill) => skill.id)).size !== 1) throw new Error(`无法唯一找到 Skill "${argument}"，请用 /skills list 查看 ID。`);
    await service.patch(matches[0].id, { project: projectPath, enabled: command === "enable" });
    write(`已${command === "enable" ? "启用" : "禁用"} ${matches[0].name}，下一次提问生效；已有对话中的 Skill 内容仍保留。`);
  } else if (command === "confirm") {
    const preview = pending.get(argument);
    if (!preview || preview.projectPath !== projectPath) throw new Error("找不到当前项目的待确认预览，请先执行 /skills import。");
    const result = await service.confirm(argument);
    write(`已导入 ${result.installed.name}，下一次提问生效。`);
  } else throw new Error("支持: /skills list | import <来源> | enable <名称或ID> | disable <名称或ID> | confirm <预览ID>");
  return true;
}

const EXIT_WORDS = new Set(["exit", "quit", "q", "退出"]);

export interface ReplOptions {
  /** 是否显示模型的思考过程（reasoning）。默认 true。 */
  showThinking?: boolean;
}

// ---------- ANSI 样式（非 TTY 或 NO_COLOR 时自动关闭） ----------
const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s);
const gray = (s: string) => (useColor() ? `\x1b[90m${s}\x1b[0m` : s);
const cyan = (s: string) => (useColor() ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s: string) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (useColor() ? `\x1b[31m${s}\x1b[0m` : s);

/** 把工具参数压缩成一行短预览。 */
function compactArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  } catch {
    return "";
  }
}

/** 从工具结果里抽取一行文本预览。 */
function resultPreview(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((c) => c && typeof c === "object" && c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
}

/**
 * 交互式聊天循环：读取用户输入 → 流式输出回答 → 支持无限追问。
 * 额外可视化：
 *   - 工具调用（tool_execution_start / tool_execution_end）：显示工具名、参数、耗时与结果预览
 *   - 思考过程（thinking_* / text_delta）：思考内容以暗色内联流式输出
 */
export async function startRepl(session: AgentSession, options: ReplOptions = {}): Promise<void> {
  const showThinking = options.showThinking ?? true;
  const snapshot = getSessionSkills(session);
  const pending = new Map<string, SkillPreview>();
  const service = snapshot ? (await import("./skills/service.js")).getSkillService() : undefined;

  // 行状态：用于在「内联内容」与「元信息行」之间正确换行
  let midLine = false;
  let inThinking = false;
  const toolStart = new Map<string, number>();

  const writeInline = (s: string) => {
    process.stdout.write(s);
    if (s.length > 0) midLine = !s.endsWith("\n");
  };

  const forceNewline = () => {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
  };

  const metaLine = (s: string) => {
    forceNewline();
    process.stdout.write(s + "\n");
    midLine = false;
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") {
        inThinking = false;
        writeInline(ev.delta);
      } else if (ev.type === "thinking_start" && showThinking) {
        metaLine(gray("[思考]"));
        inThinking = true;
      } else if (ev.type === "thinking_delta" && showThinking) {
        writeInline(dim(ev.delta));
      } else if (ev.type === "thinking_end" && inThinking) {
        forceNewline();
        inThinking = false;
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const args = compactArgs(event.args);
      metaLine(cyan(`⚙ ${event.toolName}`) + (args ? gray(`  ${args}`) : ""));
      toolStart.set(event.toolCallId, Date.now());
      return;
    }

    if (event.type === "tool_execution_end") {
      const start = toolStart.get(event.toolCallId);
      toolStart.delete(event.toolCallId);
      const dur = start ? gray(` · ${((Date.now() - start) / 1000).toFixed(1)}s`) : "";
      const mark = event.isError ? red("✗") : green("✓");
      const preview = resultPreview(event.result);
      metaLine(
        `  ${mark} ${event.toolName}${dur}` + (preview ? gray(`  → ${preview}`) : ""),
      );
      return;
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let running = false;
  let feedbackClient: string | undefined;
  let turnAbort: AbortController | undefined;
  let isClosed = false;

  // 关闭信号（Ctrl+D / stdin EOF / rl.close()）
  rl.on("close", () => {
    isClosed = true;
  });

  // Ctrl+C：运行中则中止当前回答，空闲则退出
  rl.on("SIGINT", () => {
    if (running) {
      turnAbort?.abort();
      session.abort().catch(() => {});
      process.stdout.write("\n[已中止当前回答]\n");
      midLine = false;
    } else {
      process.stdout.write("\n再见！\n");
      rl.close();
    }
  });

  // Keep piped lines until consumed; readline.question() can lose input while an async turn runs.
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  rl.on("line", (line) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); }
    else lines.push(line);
  });
  rl.on("close", () => { waiting?.(null); waiting = undefined; });
  const ask = (prompt = "> "): Promise<string | null> => {
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (isClosed) return Promise.resolve(null);
    process.stdout.write(prompt);
    return new Promise((resolve) => { waiting = resolve; });
  };
  const confirmPreviews = async (previews: SkillPreview[], showPreview = true) => {
    for (const preview of previews) {
      pending.set(preview.id, preview);
      if (showPreview) metaLine(describeSkillPreview(preview));
      if (process.stdin.isTTY && process.stdout.isTTY && !isClosed) {
        const answer = await ask(`确认向 ${preview.projectPath} 导入 ${preview.skill.name}？[y/N] `);
        if (/^(y|yes)$/i.test(answer?.trim() ?? "") && service && snapshot) {
          await executeSkillsCommand(`/skills confirm ${preview.id}`, { projectPath: snapshot.projectPath, service, pending, write: metaLine });
        }
      }
    }
  };

  try {
    while (true) {
      const line = await ask();
      if (line === null) break; // EOF
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (EXIT_WORDS.has(trimmed.toLowerCase())) break;

      running = true;
      turnAbort = new AbortController();
      const turnPreviews: SkillPreview[] = [];
      const commandPreviews: SkillPreview[] = [];
      try {
        const memory = getSessionMemory(session);
        let bypassQuestion: string | undefined;
        if (/^\/(?:memory|feedback)(?:\s|$)/.test(trimmed)) {
          if (!memory) throw new Error("记忆功能未启用，请使用 Node 22.13 及以上版本。");
          const command = await executeMemoryCommand(trimmed, { ...memory, policyHash: sessionPolicyHash(session), clientId: feedbackClient ??= replFeedbackClientId(), write: metaLine });
          if (command.handled && !command.bypassQuestion) continue;
          bypassQuestion = command.bypassQuestion;
        }
        const previousIds = new Set(pending.keys());
        const handled = service && snapshot && await executeSkillsCommand(trimmed, { projectPath: snapshot.projectPath, service, pending, write: metaLine });
        if (handled) {
          const created = [...pending.values()].filter((preview) => !previousIds.has(preview.id));
          commandPreviews.push(...created);
        } else {
          if (/^\/skills(?:\s|$)/.test(trimmed)) throw new Error("当前会话未绑定项目 Skills 服务。");
          await runAsk(session, bypassQuestion ?? trimmed, (event) => {
            if (event.type === "skill_preview") turnPreviews.push(event.preview);
            if (event.type === "answer_reused") { metaLine("[复用已审核知识]"); process.stdout.write(event.answer); }
          }, turnAbort.signal, { reuse: bypassQuestion ? "bypass" : "auto" });
        }
        forceNewline();
      } catch (e) {
        forceNewline();
        process.stdout.write(
          "\n[错误] " + (e instanceof Error ? e.message : String(e)) + "\n",
        );
      } finally {
        running = false;
        turnAbort = undefined;
      }
      if (turnPreviews.length || commandPreviews.length) {
        try {
          await confirmPreviews(turnPreviews);
          if (process.stdin.isTTY && process.stdout.isTTY) await confirmPreviews(commandPreviews, false);
        }
        catch (error) { metaLine("[错误] " + (error instanceof Error ? error.message : String(error))); }
      }
    }
  } finally {
    rl.close();
    unsubscribe();
    session.dispose();
  }
}
