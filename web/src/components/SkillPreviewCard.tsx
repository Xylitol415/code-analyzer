import { useEffect, useState } from "react";
import type { SkillPreview } from "../types";
import { Button } from "./Button";

export const SKILLS_REFRESH_HINT = "启用、停用或切换版本将在下一次提问前刷新。停用不会移除历史上下文中已有的指令。";

export function SkillPreviewCard({ preview, confirmed = false, onConfirm, onCancel }: {
  preview: SkillPreview;
  confirmed?: boolean;
  onConfirm?: (preview: SkillPreview) => Promise<void>;
  onCancel?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const expiresAt = new Date(preview.expiresAt).getTime();
  const [expired, setExpired] = useState(!Number.isFinite(expiresAt) || expiresAt <= Date.now());
  useEffect(() => {
    if (expired) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt, expired]);

  const confirm = async () => {
    if (pending || expired || confirmed || !onConfirm) return;
    if (Date.now() >= expiresAt) { setExpired(true); return; }
    setPending(true);
    setError("");
    try { await onConfirm(preview); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "导入失败，请重试。"); }
    finally { setPending(false); }
  };

  return (
    <section aria-label={`导入预览：${preview.skill.name}`} className="my-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 text-sm text-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold text-slate-900">{preview.skill.name} <span className="font-normal text-slate-500">导入预览</span></h3>
        <code title={preview.skill.version} className="break-all text-xs text-slate-500">{preview.skill.version}</code>
      </div>
      <p className="mt-2 whitespace-pre-wrap">{preview.skill.description}</p>
      <dl className="mt-3 space-y-1 text-xs text-slate-500">
        <div><dt className="inline">项目：</dt><dd className="inline break-all">{preview.projectPath}</dd></div>
        <div><dt className="inline">来源（{preview.skill.source.kind}）：</dt><dd className="inline break-all">{preview.skill.source.label}</dd></div>
        <div><dt className="inline">有效期至：</dt><dd className="inline">{preview.expiresAt}</dd></div>
      </dl>
      {preview.replacement && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">将替换已启用的 {preview.replacement.name}（{preview.replacement.version}）。旧版本仍保留在技能库。</p>}
      {preview.warnings.length > 0 && <ul aria-label="导入警告" className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {preview.skill.disableModelInvocation && <p className="mt-2 text-xs text-slate-600">仅支持显式调用，模型不会自动选用。</p>}
      <details className="mt-3 text-xs" open>
        <summary className="cursor-pointer font-medium">文件清单（{preview.skill.files.length}）</summary>
        <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-lg bg-white/70 p-2">
          {preview.skill.files.map((file) => <li key={file.path} className="flex justify-between gap-3"><code className="break-all">{file.path}</code><span className="shrink-0 text-slate-400">{file.size} B</span></li>)}
        </ul>
      </details>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{SKILLS_REFRESH_HINT}</p>
      {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
      {confirmed ? <p role="status" className="mt-3 font-medium text-emerald-700">已导入并启用，将在下一次提问生效。</p>
        : <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" loading={pending} disabled={expired || !onConfirm} onClick={confirm}>确认导入并启用</Button>
          {onCancel && <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>取消预览</Button>}
          {expired && <span role="status" className="text-xs text-amber-700">预览已过期，请重新导入。</span>}
          {!onConfirm && !expired && <span className="text-xs text-slate-500">请在当前项目的 Skills 面板重新预览。</span>}
        </div>}
    </section>
  );
}
