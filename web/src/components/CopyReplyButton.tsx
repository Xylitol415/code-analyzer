import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "./Icons";

type CopyStatus = "idle" | "copying" | "copied" | "error";

export function CopyReplyButton({ content }: { content: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [error, setError] = useState("");
  const operationRef = useRef(0);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setStatus("idle");
    setError("");
    return () => {
      // A clipboard operation may finish after this message changes or disappears.
      operationRef.current += 1;
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, [content]);

  const copy = async () => {
    if (status === "copying") return;
    const operation = ++operationRef.current;
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setStatus("copying");
    setError("");
    let clipboardAvailable = false;
    try {
      clipboardAvailable = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
      if (!clipboardAvailable) throw new Error("Clipboard unavailable");
      // Copy the source, so code fences and diagram syntax are preserved exactly.
      await navigator.clipboard.writeText(content);
      if (operationRef.current !== operation) return;
      setStatus("copied");
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null;
        if (operationRef.current === operation) setStatus("idle");
      }, 2000);
    } catch {
      if (operationRef.current !== operation) return;
      setStatus("error");
      setError(clipboardAvailable
        ? "复制失败，请检查浏览器剪贴板权限后重试。"
        : "当前环境无法访问剪贴板，请使用 HTTPS 或 localhost 页面后重试。");
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <button type="button" aria-label="复制回复" title={status === "copied" ? "已复制" : "复制 Markdown 原文"}
        disabled={status === "copying"} onClick={copy}
        className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-50">
        {status === "copied" ? (
          <span aria-hidden="true"><CheckIcon className="h-4 w-4 text-emerald-600" /></span>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <rect x="8" y="8" width="12" height="13" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
          </svg>
        )}
      </button>
      <span role="status" aria-live="polite" className={`text-xs ${status === "error" ? "text-rose-600" : "text-slate-500"}`}>
        {status === "copied" ? "已复制" : status === "error" ? error : ""}
      </span>
    </div>
  );
}
