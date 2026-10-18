import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { HistorySessionInfo } from "./session-history.js";

export type SessionChoice = { resume: false; historyId?: string };

function singleLine(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatSessionHistory(history: HistorySessionInfo[]): string {
  if (!history.length) return "暂无历史会话。\n";
  return "历史会话（最近更新在前）：\n" + history.map((session, index) => {
    const title = singleLine(session.title);
    const preview = title.length > 80 ? title.slice(0, 80) + "…" : title;
    const updated = new Date(session.updatedAt).toLocaleString("zh-CN", { hour12: false });
    return `  ${index + 1}. ${preview || "未命名会话"}\n` +
      `     ${updated} · ${session.messageCount} 条消息${session.modelLabel ? " · " + singleLine(session.modelLabel) : ""}\n` +
      `     ID: ${singleLine(session.id)}\n`;
  }).join("");
}

/** Non-interactive callers always start fresh and never consume piped questions. */
export async function chooseStartupSession(
  history: HistorySessionInfo[],
  options: { input?: Readable; output?: Writable; interactive?: boolean } = {},
): Promise<SessionChoice | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return { resume: false };
  output.write(formatSessionHistory(history));
  output.write("  0. 新建会话（默认）\n  q. 退出\n");
  const rl = readline.createInterface({ input, output });
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.on("SIGINT", () => rl.close());
  const readChoice = (): Promise<string | null> => new Promise((resolve) => {
    if (closed || input.readableEnded || input.destroyed) return resolve(null);
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.question("选择会话 [0]：", (line) => {
      rl.removeListener("close", onClose);
      resolve(line.trim());
    });
  });
  try {
    while (true) {
      const choice = await readChoice();
      if (choice === null || /^(q|quit|exit)$/i.test(choice)) return null;
      if (choice === "" || choice === "0") return { resume: false };
      if (/^[1-9]\d*$/.test(choice)) {
        const selected = history[Number(choice) - 1];
        if (selected) return { resume: false, historyId: selected.id };
      }
      output.write(`请输入 0 到 ${history.length} 之间的序号，或 q 退出。\n`);
    }
  } finally {
    rl.close();
  }
}
