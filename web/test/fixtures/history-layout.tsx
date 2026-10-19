/** Browser regression: actual App + restore flow, entirely local deterministic API responses.
 * npm run dev -- --port 5176, open /test/fixtures/history-layout.html.
 * Any project/token works: choose backend model and restore "长历史布局回归".
 * data-status must be pass; document height must equal the viewport while chat still scrolls.
 */
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import "../../src/index.css";

const messages = Array.from({ length: 20 }, (_, i) => [
  { id: `user-${i}`, role: "user", content: `历史问题 ${i + 1}：请说明会话的实现。`, thinking: "", tools: [], streaming: false },
  { id: `answer-${i}`, role: "assistant", thinking: "", tools: [], streaming: false,
    content: `### 历史回答 ${i + 1}\n\n这是恢复后的已有回答，包含 Markdown、源码片段和复制入口。\n\n1. 请求进入会话队列。\n2. 读取源码并分析。\n3. 保留结果与历史。\n\n\`\`\`ts\nconst enabled = true;\n\`\`\`\n\n${i === 19 ? "末条历史回答：输入框应始终位于视口底部。" : "本条结束。"}` },
]).flat();

// No real backend, project, credentials, history store or model is accessed.
window.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/models")) return Response.json({ models: [{ provider: "fixture", id: "model", name: "Layout fixture" }], default: "fixture/model" });
  if (url.pathname.endsWith("/history")) return Response.json({ projectPath: "/layout-fixture", sessions: [{ id: "layout-history", title: "长历史布局回归", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", messageCount: messages.length, active: false, modelLabel: "fixture/model" }] });
  if (url.pathname.endsWith("/sessions") && init?.method === "POST") return Response.json({ id: "layout-session", historyId: "layout-history", resumed: true, projectPath: "/layout-fixture", modelLabel: "fixture/model", messages });
  if (init?.method === "DELETE") return Response.json({ ok: true });
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};

createRoot(document.getElementById("root")!).render(<App />);
const output = document.getElementById("layout-result")!;
let frame = 0;
function measure() {
  const shell = document.getElementById("root")!.firstElementChild!;
  const chat = [...shell.children].find(el => getComputedStyle(el).overflowY === "auto") as HTMLElement | undefined;
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="提问内容"]');
  if (!chat || !input || document.querySelectorAll(".markdown-body").length !== 20) return;
  const footer = input.parentElement!.parentElement!;
  const viewport = document.documentElement.clientHeight;
  const pageHeight = document.scrollingElement!.scrollHeight;
  const footerBottom = footer.getBoundingClientRect().bottom;
  const pass = pageHeight <= viewport + 1 && Math.abs(footerBottom - viewport) <= 1 && chat.scrollHeight > chat.clientHeight;
  output.dataset.status = pass ? "pass" : "fail";
  output.textContent = JSON.stringify({ status: pass ? "pass" : "fail", viewport, pageHeight, footerBottom, chatHeight: chat.clientHeight, chatScrollHeight: chat.scrollHeight });
}
function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(measure); }); }
new MutationObserver(schedule).observe(document.getElementById("root")!, { subtree: true, childList: true });
window.addEventListener("resize", schedule);
window.addEventListener("scroll", schedule, true);
