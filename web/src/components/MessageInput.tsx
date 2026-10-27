import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PendingSessionMessage } from "../types";
import { Button } from "./Button";
import { SendIcon, StopIcon } from "./Icons";

export interface MessageInputProps {
  disabled: boolean;
  streaming: boolean;
  sendingBlocked?: boolean;
  onSend: (text: string, reuse?: "auto" | "bypass") => void | Promise<void>;
  onQueue?: (text: string, reuse?: "auto" | "bypass") => void | Promise<void>;
  onSteer?: (text: string) => void | Promise<void>;
  pendingMessages?: PendingSessionMessage[];
  onCancelPending?: (id: string) => Promise<PendingSessionMessage>;
  scopeKey?: string | null;
  onStop: () => void;
}

function resizeInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  // Empty input must use rows=1, regardless of the placeholder's wrapped height.
  if (!input.value) return;

  const style = getComputedStyle(input);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const contentHeight = Math.ceil(input.scrollHeight + border);
  const maxHeight = parseFloat(style.maxHeight) || contentHeight;
  input.style.height = Math.min(contentHeight, maxHeight) + "px";
  input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

export function MessageInput(props: MessageInputProps) {
  const [bypass, setBypass] = useState(false);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const operationRef = useRef<string | null>(null);
  const scope = useRef(props.scopeKey);
  scope.current = props.scopeKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    operationRef.current = null;
    setOperation(null); setNotice(""); setEditing(false);
  }, [props.scopeKey]);
  const isCurrent = (origin: typeof props.scopeKey) => mounted.current && scope.current === origin;
  const begin = (id: string) => { operationRef.current = id; setOperation(id); setNotice(""); };
  const finish = () => { operationRef.current = null; setOperation(null); };
  const pending = props.pendingMessages ?? [];
  const blocked = props.disabled || props.sendingBlocked || !!operation;


  useLayoutEffect(() => {
    if (ref.current) resizeInput(ref.current);
  }, [value]);

  useEffect(() => {
    const input = ref.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    let width = input.getBoundingClientRect().width;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      // Observe width only, then mutate height outside observer delivery.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => resizeInput(input));
    });
    observer.observe(input);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const submit = async (mode: "steer" | "followUp" = "followUp") => {
    const text = value.trim();
    if (!text || props.disabled || props.sendingBlocked || operationRef.current) return;
    const origin = props.scopeKey;
    if (!props.streaming) {
      // Ordinary send retains its complete-stream Promise API.
      try {
        const result = props.onSend(text, bypass ? "bypass" : "auto");
        setValue(""); setEditing(false); setNotice("");
        void Promise.resolve(result).catch(error => { if (isCurrent(origin)) setNotice(error instanceof Error ? error.message : "发送失败"); });
      } catch (error) { setNotice(error instanceof Error ? error.message : "发送失败"); }
      return;
    }
    begin("submit");
    try {
      if (mode === "steer") {
        if (!props.onSteer) throw new Error("当前无法引导，请稍后重试。");
        await props.onSteer(text);
      } else {
        if (!props.onQueue) throw new Error("当前无法排队，请稍后重试。");
        await props.onQueue(text, bypass ? "bypass" : "auto");
      }
      if (!isCurrent(origin)) return;
      setValue(""); setEditing(false);
      setNotice(mode === "steer" ? "引导已提交，等待采用。" : "已加入待执行队列。");
    } catch (error) {
      if (isCurrent(origin)) setNotice(error instanceof Error ? error.message : "提交失败，请重试。");
    } finally { if (isCurrent(origin)) finish(); }
  };

  const cancel = async (message: PendingSessionMessage, edit: boolean) => {
    if (operationRef.current || !props.onCancelPending) return;
    if (edit && value.length) {
      setNotice("输入框已有草稿，请先发送或清空，再撤回编辑。");
      ref.current?.focus();
      return;
    }
    const origin = props.scopeKey;
    begin(message.id);
    try {
      const removed = await props.onCancelPending(message.id);
      if (!isCurrent(origin)) return;
      if (edit) {
        setValue(removed.question);
        setBypass(removed.reuse === "bypass");
        setEditing(true);
        ref.current?.focus();
      } else setNotice("已删除这条待处理消息。");
    } catch (error) {
      if (isCurrent(origin)) setNotice(error instanceof Error ? error.message : "撤回失败，请重试。");
    } finally { if (isCurrent(origin)) finish(); }
  };

  return (
    <div className="@container relative z-10 shrink-0 border-t border-slate-200 bg-white px-4 py-3">
      {pending.length > 0 && <aside aria-label="待处理消息" className="absolute right-4 bottom-full left-4 mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3 shadow-lg @sm:right-6 @sm:left-6 mx-auto max-w-5xl">
        <div className="mb-2 flex items-center gap-2 px-1 text-xs text-slate-500"><strong className="font-medium text-slate-700">待处理</strong><span className="rounded bg-slate-200 px-1.5">{pending.length}</span><span className="ml-auto hidden @sm:inline">引导优先 · 排队按顺序执行</span></div>
        <div className="max-h-[min(40dvh,24rem)] space-y-2 overflow-y-auto">
          {pending.map((message) => <article key={message.id} className={`rounded-lg border p-3 ${message.mode === "steer" ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white"}`}>
            <div className="flex items-center justify-between gap-2 text-xs"><span className={message.mode === "steer" ? "font-medium text-indigo-600" : "font-medium text-slate-600"}>{message.mode === "steer" ? "引导" : "排队"}</span><span className="text-slate-500">{message.status === "unapplied" ? "未采用" : message.mode === "steer" ? "待采用" : "待执行"}</span></div>
            <p className="m-0 mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{message.question}</p>
            <div className="mt-2 flex justify-end gap-3 text-xs">
              <button type="button" aria-label={`撤回编辑：${message.question}`} disabled={!!operation || props.disabled} className="cursor-pointer rounded border-0 bg-transparent px-1.5 py-1.5 text-indigo-600 hover:bg-indigo-100 disabled:opacity-50" onClick={() => { void cancel(message, true); }}>撤回编辑</button>
              <button type="button" aria-label={`删除：${message.question}`} disabled={!!operation || props.disabled} className="cursor-pointer rounded border-0 bg-transparent px-1.5 py-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50" onClick={() => { void cancel(message, false); }}>删除</button>
            </div>
          </article>)}
        </div>
      </aside>}
      <div className="mx-auto max-w-5xl">
        {notice && <p role="status" aria-live="polite" className="mb-2 text-xs text-slate-600">{notice}</p>}
        {editing && <p className="mb-2 text-xs text-indigo-600">已撤回消息，可编辑后重新发送</p>}
        <div className="flex flex-wrap items-end gap-2 @sm:flex-nowrap">
          <textarea
            ref={ref}
            aria-label="提问内容"
            rows={1}
            value={value}
            placeholder={props.disabled ? "打开右上角「会话配置」并建会话" : props.streaming ? "补充要求或输入下一个问题，Enter 排队" : "输入问题，Enter 发送，Shift+Enter 换行"}
            className="box-border min-w-0 max-h-44 flex-[1_1_100%] resize-none overflow-y-auto rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-900 placeholder:whitespace-nowrap placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40 focus:outline-none @sm:flex-1"
            onChange={(event) => { if (!operationRef.current) { setValue(event.target.value); setNotice(""); } }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
            }}
            disabled={props.disabled || !!operation}
          />
          {props.streaming ? <>
            <Button className="flex-1 @sm:flex-none" variant="ghost" onClick={() => { void submit("steer"); }} disabled={blocked || !value.trim()} title="在当前任务的下一执行边界采用">引导</Button>
            <Button className="flex-1 border-0 @sm:flex-none" onClick={() => { void submit("followUp"); }} disabled={blocked || !value.trim()}>排队</Button>
          </> : <Button className="border-0" onClick={() => { void submit(); }} disabled={blocked || !value.trim()}><SendIcon className="h-4 w-4" />发送</Button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <label className="flex items-center gap-2"><input type="checkbox" checked={bypass} onChange={(event) => setBypass(event.target.checked)} disabled={props.disabled || !!operation} />本次跳过知识复用</label>
          {props.streaming && <><span className="hidden @sm:inline">· Enter 排队 · Shift+Enter 换行</span><button type="button" onClick={props.onStop} className="ml-auto flex cursor-pointer items-center border-0 bg-transparent gap-1 rounded px-1.5 py-1 text-slate-500 hover:text-red-600"><StopIcon className="h-3 w-3" />停止当前</button></>}
        </div>
      </div>
    </div>
  );
}
