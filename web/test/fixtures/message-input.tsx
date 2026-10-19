/** Real browser layout check; npm --prefix web run dev -- --port 5177.
 * Open /test/fixtures/message-input.html. No backend or model is used.
 * Empty and short input stay one row; wrapped/explicit lines grow, then shrink.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageInput } from "../../src/components/MessageInput";
import "../../src/index.css";

function Fixture() {
  const [width, setWidth] = useState("wide");
  const [sent, setSent] = useState("");
  const [result, setResult] = useState<{ status: string; checks: Array<{ name: string; pass: boolean; height: number }> }>({ status: "pending", checks: [] });
  const [running, setRunning] = useState(false);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const run = async () => {
    setRunning(true);
    const checks: Array<{ name: string; pass: boolean; height: number }> = [];
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener("error", onError);
    try {
      const input = document.querySelector<HTMLTextAreaElement>('[aria-label="提问内容"]')!;
      const height = () => input.getBoundingClientRect().height;
      const style = getComputedStyle(input);
      const oneRow = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const check = (name: string, pass: boolean) => checks.push({ name, pass, height: height() });
      const singleRow = () => Math.abs(height() - oneRow) <= 1;
      const type = async (value: string) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
      };
      setWidth("wide"); await frame();
      await type("");
      input.focus(); await frame();
      check("empty focus stays one row", singleRow());
      await type("你好"); check("short text stays one row", singleRow());
      await type("第一行\n第二行"); check("explicit newline grows", height() >= oneRow + parseFloat(style.lineHeight) - 1);
      await type("短句"); check("deleting back to one line shrinks", singleRow());
      await type("这是用于验证文字折行后自动增高的内容。".repeat(6));
      const wideHeight = height(); check("wrapped text grows", wideHeight > oneRow + 1);
      setWidth("narrow"); await frame();
      check("narrower container reflows draft", height() > wideHeight);
      setWidth("wide"); await frame();
      check("wider container shrinks draft", Math.abs(height() - wideHeight) <= 1);
      await type("很长的内容".repeat(300));
      check("long draft is capped and scrollable", height() <= parseFloat(getComputedStyle(input).maxHeight) + 1 && input.scrollHeight > input.clientHeight);
      await type(""); check("clearing restores one row", singleRow());
      setWidth("narrow"); await frame();
      check("long placeholder never grows empty input", singleRow());
      await type("第一行\n第二行");
      input.parentElement!.querySelector<HTMLButtonElement>("button")!.click(); await frame();
      check("sending clears and restores one row", input.value === "" && singleRow());
      check("no browser layout errors", errors.length === 0);
      setResult({ status: checks.every(check => check.pass) ? "pass" : "fail", checks });
    } finally { window.removeEventListener("error", onError); setRunning(false); }
  };
  return <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
    <h1>提问输入框布局回归</h1>
    <p>空内容和短文本保持一行；长文本和手动换行增高；删除、发送后收回。</p>
    <button type="button" onClick={() => setWidth(width === "wide" ? "narrow" : "wide")}>切换容器宽度</button>
    <button type="button" disabled={running} onClick={() => void run()}>运行输入框布局回归</button>
    <section aria-label="输入框测试容器" style={{ width: width === "wide" ? "min(100%, 1100px)" : 340, marginTop: 20 }}>
      <MessageInput disabled={false} streaming={false} onSend={setSent} onStop={() => {}} />
    </section>
    <output aria-label="最近发送内容">{sent}</output>
    <pre aria-label="输入框布局测试结果" data-status={result.status}>{JSON.stringify(result, null, 2)}</pre>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
