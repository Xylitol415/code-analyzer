import { memo, useEffect, useState } from "react";
import { mermaidRenderer } from "../lib/mermaid-renderer";
import { Spinner } from "./Spinner";

interface Props {
  source: string;
  complete: boolean;
  streaming: boolean;
}

export const MermaidDiagram = memo(function MermaidDiagram({ source, complete, streaming }: Props) {
  const [result, setResult] = useState<{ source: string; image?: string; minWidth?: number; error?: boolean } | null>(null);
  const current = complete && result?.source === source ? result : null;

  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    void mermaidRenderer.render(source).then((svg) => {
      const viewBox = /<svg\b[^>]*\bviewBox=["']([^"']+)["']/i.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
      const width = viewBox?.[2];
      if (!cancelled) setResult({
        source,
        image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        // Fit ordinary diagrams to the reply. Large architectures retain a
        // readable scale and scroll instead of shrinking every label to a dot.
        minWidth: width !== undefined && Number.isFinite(width) && width > 1000 ? width : undefined,
      });
    }).catch(() => {
      if (!cancelled) setResult({ source, error: true });
    });
    return () => { cancelled = true; };
  }, [source, complete]);

  const pending = !complete && streaming;
  const drawing = complete && !current;
  const label = pending ? "图表生成中…" : drawing ? "正在绘制图表…"
    : !complete ? "图表未完成，可复制回复原文查看。"
      : "图表未能生成，可复制回复原文查看。";

  return (
    <figure className="my-3 mx-0 min-w-0 overflow-hidden rounded-xl border border-solid border-slate-200 bg-white">
      {current?.image ? (
        <div className="overflow-x-auto overscroll-x-contain p-4" tabIndex={0} role="region" aria-label="Mermaid 图表，可横向滚动">
          <img src={current.image} alt="Mermaid 图表" className="mx-auto block h-auto max-w-full" style={{ minWidth: current.minWidth }}
            onError={() => setResult({ source, error: true })} />
        </div>
      ) : (
        <div role="status" className="flex min-h-20 items-center gap-2 px-4 py-3 text-xs text-slate-500" aria-live="polite">
          {(pending || drawing) && <Spinner className="h-3.5 w-3.5 shrink-0" />}
          <span>{label}</span>
        </div>
      )}
    </figure>
  );
});
