/** Local UI fixture. No backend or model requests. */
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {MessageInput} from "../../src/components/MessageInput";
import type {PendingSessionMessage} from "../../src/types";
import "../../src/index.css";
const initial: PendingSessionMessage[] = [
  {id: "steer", mode: "steer", question: "只看 memberx 开头的首页接口，重点补充异常降级分支。\n请附上对应的源码位置。", createdAt: 1, status: "pending"},
  {id: "next", mode: "followUp", question: "接着画一张首页接口与下游服务的调用时序图。", createdAt: 2, status: "pending"},
  {id: "unused", mode: "steer", question: "这条引导未采用，可以撤回编辑或删除。", createdAt: 3, status: "unapplied"},
];
function Fixture() {
  const [pending, setPending] = useState(initial);
  const [streaming, setStreaming] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [failure, setFailure] = useState(false);
  const [sent, setSent] = useState("");
  const [checks, setChecks] = useState<Array<{name: string; pass: boolean}>>([]);
  const [running, setRunning] = useState(false);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const cancel = async (id: string) => {
    await frame();
    if (failure) throw new Error("消息已开始执行，请保留草稿。");
    const message = pending.find(item => item.id === id)!;
    setPending(previous => previous.filter(item => item.id !== id));
    return message;
  };
  const queue = async (question: string, mode: "steer" | "followUp") => {
    await frame();
    if (failure) throw new Error("任务已结束，请保留草稿。");
    setPending(previous => [...previous, {id: crypto.randomUUID(), question, mode, createdAt: Date.now(), status: "pending"}]);
  };
  const run = async () => {
    setRunning(true); setPending(initial); setStreaming(true); setFailure(false); setNarrow(false);
    const result: typeof checks = [];
    const check = (name: string, pass: boolean) => result.push({name, pass});
    const editor = () => document.querySelector<HTMLTextAreaElement>('[aria-label="提问内容"]')!;
    const type = async (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
      editor().dispatchEvent(new Event("input", {bubbles: true})); await frame();
    };
    const click = async (label: string) => {Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find(button => button.getAttribute("aria-label") === label)!.click(); await frame(); await frame();};
    try {
      await frame(); await type("");
      const dock = document.querySelector<HTMLElement>('[aria-label="待处理消息"]')!;
      check("full message cards and unapplied state visible", dock.textContent!.includes("请附上对应的源码位置。") && dock.textContent!.includes("未采用"));
      check("dock remains above composer", dock.getBoundingClientRect().bottom <= editor().getBoundingClientRect().top);
      await type("Keep draft"); await click(`撤回编辑：${initial[0].question}`);
      check("withdraw does not overwrite draft", editor().value === "Keep draft" && dock.querySelectorAll("article").length === 3);
      await type(""); await click(`撤回编辑：${initial[0].question}`);
      check("withdraw fills after confirmation", editor().value === initial[0].question && dock.querySelectorAll("article").length === 2);
      editor().dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true})); await frame(); await frame();
      check("Enter queues and clears draft", editor().value === "" && dock.querySelectorAll("article").length === 3);
      await click(`删除：${initial[1].question}`);
      check("delete removes confirmed card", dock.querySelectorAll("article").length === 2);
      setNarrow(true); await frame();
      check("narrow composer stays inside viewport", editor().getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth);
      setChecks(result);
    } finally {setRunning(false);}
  };
  return <main className="mx-auto max-w-6xl p-4 font-sans">
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><button onClick={() => void run()} disabled={running}>运行交互回归</button><button onClick={() => setNarrow(!narrow)}>切换窄屏</button><button onClick={() => {setPending(initial); setStreaming(true);}}>重置预览</button><label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} />模拟后端冲突</label></div>
    <section aria-label="消息卡片预览" className="mx-auto flex h-[780px] max-h-[85dvh] flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50" style={{maxWidth: narrow ? 360 : undefined}}>
      <header className="border-b border-slate-200 bg-white px-5 py-4 text-sm font-semibold">code-analyzer · memberx</header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="ml-auto w-fit rounded-xl bg-indigo-600 px-4 py-3 text-sm text-white">首页接口的核心逻辑流程是什么？</div><p className="mt-6 text-sm leading-relaxed text-slate-700">我先定位接口入口，再整理主流程、上下游调用与异常分支。</p></div>
      <MessageInput disabled={false} scopeKey="fixture" streaming={streaming} pendingMessages={pending} onSend={setSent} onQueue={question => queue(question, "followUp")} onSteer={question => queue(question, "steer")} onCancelPending={cancel} onStop={() => setStreaming(false)} />
    </section>
    <output aria-label="最近发送内容">{sent}</output>
    <pre aria-label="消息交互测试结果" data-status={checks.length ? checks.every(item => item.pass) ? "pass" : "fail" : "pending"}>{JSON.stringify(checks, null, 2)}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
