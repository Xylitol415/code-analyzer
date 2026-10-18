import readline from "node:readline";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runAsk } from "./ask.js";

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
  let isClosed = false;

  // 关闭信号（Ctrl+D / stdin EOF / rl.close()）
  rl.on("close", () => {
    isClosed = true;
  });

  // Ctrl+C：运行中则中止当前回答，空闲则退出
  rl.on("SIGINT", () => {
    if (running) {
      session.abort().catch(() => {});
      process.stdout.write("\n[已中止当前回答]\n");
      midLine = false;
    } else {
      process.stdout.write("\n再见！\n");
      rl.close();
    }
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (isClosed) return resolve(null);
      const onClose = () => resolve(null);
      rl.once("close", onClose);
      try {
        rl.question("> ", (answer) => {
          rl.removeListener("close", onClose);
          resolve(answer);
        });
      } catch {
        rl.removeListener("close", onClose);
        resolve(null);
      }
    });

  try {
    while (true) {
      const line = await ask();
      if (line === null) break; // EOF
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (EXIT_WORDS.has(trimmed.toLowerCase())) break;

      running = true;
      try {
        await runAsk(session, trimmed);
        forceNewline();
      } catch (e) {
        forceNewline();
        process.stdout.write(
          "\n[错误] " + (e instanceof Error ? e.message : String(e)) + "\n",
        );
      } finally {
        running = false;
      }
    }
  } finally {
    rl.close();
    unsubscribe();
    session.dispose();
  }
}
