import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { collectAnswer, getFeedback, putFeedback, type ServerConfig } from "../api/client";
import type { FeedbackInput, FeedbackReason } from "../types";
import { BookOpenIcon, BookPlusIcon, CheckIcon, FeedbackIcon, ThumbIcon, XIcon } from "./Icons";
import { ReplyActionButton } from "./ReplyActionButton";

const CLIENT_KEY = "code-analyzer-feedback-client";
let temporaryClientId: string | undefined;
function clientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(saved)) return saved;
  } catch { /* Private browsing may deny storage. */ }
  const id = temporaryClientId ??= crypto.randomUUID();
  try { localStorage.setItem(CLIENT_KEY, id); } catch { /* Feedback still works for this page. */ }
  return id;
}

/** Remounted with the answer's actual backend/session binding. */
export function AnswerFeedback({ answerId, config }: { answerId: string; config: ServerConfig }) {
  const [vote, setVote] = useState<FeedbackInput["vote"]>(null);
  const [open, setOpen] = useState(false);
  const [negative, setNegative] = useState(false);
  const [collected, setCollected] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | "">("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const operation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const restoreFocus = useRef(false);
  const menuId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const nativePopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
  const close = (focusTrigger = false) => {
    if (opened.current) restoreFocus.current = focusTrigger;
    opened.current = false; setOpen(false); setNegative(false);
  };
  const toggle = () => {
    if (open) close();
    else { opened.current = true; restoreFocus.current = false; setPosition(current => ({ ...current, ready: false })); setNegative(false); setError(""); setOpen(true); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    // Async submission disables the trigger until its result has settled.
    if (!open && !busy && restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); }
  }, [open, busy]);
  useLayoutEffect(() => {
    const panel = menu.current, button = trigger.current;
    if (!open || !panel || !button) return;
    // Native popovers escape the chat scroller's clipping and provide light dismissal.
    if (nativePopover && !panel.matches(":popover-open")) panel.showPopover();
    const anchor = button.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    const above = anchor.top >= bounds.height + 8 || window.innerHeight - anchor.bottom < bounds.height + 8;
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(above ? anchor.top - bounds.height - 8 : anchor.bottom + 8, window.innerHeight - bounds.height - 8)), ready: true });
  }, [open, negative, error, nativePopover]);
  useEffect(() => {
    if (!open || !position.ready || !menu.current) return;
    menu.current.querySelector<HTMLElement>(negative ? "select" : '[role="menuitemradio"]')?.focus();
  }, [open, negative, position.ready]);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const moved = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", moved); window.removeEventListener("scroll", moved, true); };
  }, [open]);
  useEffect(() => {
    let cancelled = false;
    const request = operation.current;
    void getFeedback(config, answerId, clientId()).then(result => {
      if (!cancelled && alive.current && operation.current === request) setVote(result.vote);
    }).catch(() => { /* Voting remains available if an older backend lacks the read endpoint. */ });
    return () => { cancelled = true; };
  }, [config, answerId]);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    operation.current++;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "反馈失败，请重试。"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const submit = (next: FeedbackInput["vote"]) => run(async () => {
    const result = await putFeedback(config, answerId, { clientId: clientId(), vote: next,
      ...(next === "down" && reason ? { reason } : {}), ...(next === "down" && comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (!alive.current) return;
    setVote(result.vote); close(true); setNotice(next === null ? "反馈已清除" : "反馈已保存");
  });
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    if (negative || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])].filter(item => !item.disabled);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const option = "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-40";
  return <div className="relative text-xs">
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="回答反馈">
      <ReplyActionButton ref={trigger} label="评价回复" tooltip={vote === null ? "评价回复" : `评价回复 · ${vote === "up" ? "有帮助" : "无帮助"}`} hideTooltip={open}
        active={open || vote !== null} aria-haspopup={negative ? "dialog" : "menu"} aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={busy} onClick={toggle}
        onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) toggle(); } }}>
        {vote === null ? <FeedbackIcon className="h-[18px] w-[18px]" /> : <ThumbIcon down={vote === "down"} className="h-[18px] w-[18px]" />}
      </ReplyActionButton>
      <ReplyActionButton label="收录为候选知识" tooltip={collected ? "已收录为候选知识" : "收录为候选知识"} active={collected} disabled={busy} onClick={() => void run(async () => {
        await collectAnswer(config, answerId); if (alive.current) { setCollected(true); setNotice("已收录为候选，审核发布后可复用。"); }
      })}>{collected ? <BookOpenIcon className="h-[18px] w-[18px]" /> : <BookPlusIcon className="h-[18px] w-[18px]" />}</ReplyActionButton>
    </div>
    {open && <div ref={menu} id={menuId} popover={nativePopover ? "auto" : undefined} role={negative ? "dialog" : "menu"} aria-label={negative ? "反馈详情" : "评价回复选项"}
      onToggle={event => { if (event.newState === "closed") close(); }} onKeyDown={navigate}
      style={{ position: "fixed", inset: "auto", margin: 0, left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
      className={`z-50 box-border max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto rounded-2xl border border-solid border-slate-200 bg-white p-1.5 text-slate-700 shadow-[0_8px_30px_-8px_rgba(15,23,42,0.24)] ${negative ? "w-80" : "w-48"}`}>
      {negative ? <div className="space-y-3 p-2.5">
        <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-medium"><ThumbIcon down className="h-4 w-4" />无帮助</span><button type="button" aria-label="关闭评价" onClick={() => close(true)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-slate-400 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500"><XIcon className="h-3.5 w-3.5" /></button></div>
      <label className="block text-xs text-slate-500">原因（可选）<select aria-label="负面反馈原因" value={reason} disabled={busy} className="session-input mt-1 box-border" onChange={(event) => setReason(event.target.value as FeedbackReason | "")}>
        <option value="">未选择</option><option value="incorrect">内容错误</option><option value="outdated">已经过时</option><option value="irrelevant">不相关</option><option value="presentation">表达问题</option>
      </select></label>
      <label className="block text-xs text-slate-500">补充说明（可选）<textarea aria-label="反馈补充说明" value={comment} maxLength={4000} rows={3} disabled={busy} placeholder="哪些内容可以改进？" className="session-input mt-1 box-border resize-none" style={{ height: 88 }} onChange={(event) => setComment(event.target.value)} /></label>
      <div className="flex justify-end gap-2"><button type="button" disabled={busy} className="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2 text-xs text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-40" onClick={() => setNegative(false)}>取消</button><button type="button" disabled={busy} className="cursor-pointer rounded-lg border-0 bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-40" onClick={() => void submit("down")}>{busy ? "正在提交…" : "提交负面反馈"}</button></div>
      </div> : <>
        {(["up", "down"] as const).map(value => <button key={value} type="button" role="menuitemradio" aria-label={value === "up" ? "有帮助" : "无帮助"} aria-checked={vote === value} disabled={busy}
          className={`${option} ${vote === value ? "bg-indigo-50 text-indigo-600" : "bg-transparent text-slate-600 hover:bg-slate-50"}`} onClick={() => value === "up" ? void submit("up") : setNegative(true)}>
          <ThumbIcon down={value === "down"} className="h-4 w-4 shrink-0" /><span className="flex-1">{value === "up" ? "有帮助" : "无帮助"}</span>{vote === value && <CheckIcon className="h-3.5 w-3.5" />}
        </button>)}
        {vote !== null && <div className="mt-1 border-0 border-t border-solid border-slate-100 pt-1"><button type="button" role="menuitem" aria-label="清除反馈" disabled={busy} className={`${option} bg-transparent text-slate-400 hover:bg-slate-50 hover:text-slate-600`} onClick={() => void submit(null)}><XIcon className="h-4 w-4" /><span>撤销评价</span></button></div>}
      </>}
      {error && <p role="alert" className="m-0 px-3 pb-2 pt-1 text-xs leading-relaxed text-red-600">{error}</p>}
    </div>}
    {error && !open && <p role="alert" className="mt-1 max-w-xs text-red-600">{error}</p>}
    <span role="status" aria-live="polite" className="sr-only">{notice}</span>
  </div>;
}
