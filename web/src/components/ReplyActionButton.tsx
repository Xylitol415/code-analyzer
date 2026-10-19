import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

/** Compact reply actions share the same target size and hover/focus help. */
export function ReplyActionButton({ label, tooltip, active = false, hideTooltip = false, children, ref, className = "", ...props }: {
  label: string; tooltip: string; active?: boolean; hideTooltip?: boolean; children: ReactNode; ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tooltipId = useId();
  return <span className="group/reply-action relative inline-flex shrink-0">
    <button {...props} ref={ref} type="button" aria-label={label} aria-describedby={hideTooltip ? undefined : tooltipId}
      className={`inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-0 p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-40 ${active ? "bg-indigo-50 text-indigo-600 hover:bg-indigo-100" : "bg-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600"} ${className}`}>
      {children}
    </button>
    {!hideTooltip && <span id={tooltipId} role="tooltip" className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover/reply-action:visible group-hover/reply-action:opacity-100 group-focus-within/reply-action:visible group-focus-within/reply-action:opacity-100 motion-reduce:transition-none">{tooltip}</span>}
  </span>;
}
