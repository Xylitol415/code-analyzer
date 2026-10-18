import { useEffect, useRef, useState } from "react";
import { confirmSkillImport, listSkills, patchSkill, prepareSkillImport, type ServerConfig } from "../api/client";
import type { SkillLibrary, SkillPreview, SkillVersion } from "../types";
import { Button } from "./Button";
import { XIcon } from "./Icons";
import { SkillPreviewCard, SKILLS_REFRESH_HINT } from "./SkillPreviewCard";

export interface SkillsBinding { config: ServerConfig; project: string; connected: boolean }

/** App remounts this control whenever its session/backend/project binding changes. */
export function SkillsManager({ binding, appliedCount, appliedRevision }: {
  binding: SkillsBinding; appliedCount: number; appliedRevision: number;
}) {
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<SkillLibrary | null>(null);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const operation = useRef(0);
  const activeOperation = useRef(false);
  const ready = !!binding.project && !!binding.config.baseUrl && !!binding.config.token;
  const urlValid = publicHttpsUrl(url);

  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current += 1; }; }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open) dialog?.showModal();
    return () => dialog?.close();
  }, [open]);
  useEffect(() => {
    if (preview) previewRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [preview?.id]);

  const refresh = async () => {
    if (!ready) return;
    const id = ++operation.current;
    setLoading(true);
    setError("");
    try {
      const result = await listSkills(binding.config, binding.project);
      if (alive.current && id === operation.current) setLibrary(result);
    } catch (failure) {
      if (alive.current && id === operation.current) setError(errorText(failure));
    } finally {
      if (alive.current && id === operation.current) setLoading(false);
    }
  };
  const show = () => { setOpen(true); void refresh(); };
  const close = () => {
    setOpen(false);
    dialogRef.current?.close();
    triggerRef.current?.focus();
  };
  const run = async (action: () => Promise<void>) => {
    if (activeOperation.current) return;
    activeOperation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally { activeOperation.current = false; if (alive.current) setBusy(false); }
  };
  const prepare = (input: { file: File } | { url: string } | { localId: string }) => run(async () => {
    const result = await prepareSkillImport(binding.config, binding.project, input);
    if (!alive.current) return;
    const expectedProject = library?.projectPath ?? (binding.connected ? binding.project : null);
    if (expectedProject && result.projectPath !== expectedProject) throw new Error("预览所属项目不匹配，请刷新后重试。");
    setPreview(result); setConfirmed(false);
  });
  const confirm = async (candidate: SkillPreview) => {
    // Keep errors in the preview card so failed/expired confirmations can be retried.
    if (activeOperation.current) throw new Error("正在处理其他技能操作，请稍后重试。");
    activeOperation.current = true;
    setBusy(true);
    try {
      const result = await confirmSkillImport(binding.config, candidate.id);
      if (!alive.current) return;
      if (result.snapshot.projectPath !== candidate.projectPath) throw new Error("导入结果的项目不匹配。");
      setConfirmed(true);
      await refresh();
    } finally {
      activeOperation.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const change = (skill: SkillVersion, enabled: boolean, version?: string) => run(async () => {
    await patchSkill(binding.config, library?.projectPath ?? binding.project, skill.id, enabled, version);
    if (!alive.current) return;
    setNotice("项目技能已更新，将在下一次提问生效。");
    await refresh();
  });
  const groups = new Map<string, SkillLibrary["installed"]>();
  library?.installed.forEach((skill) => groups.set(skill.id, [...(groups.get(skill.id) ?? []), skill]));

  return <>
    <button ref={triggerRef} type="button" className="session-new-button" aria-label="Skills 管理" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? "skills-manager" : undefined} onClick={show}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M9 3h6v5h5v6h-5v7H9v-7H4V8h5z" /></svg>Skills{binding.connected && <span className="text-slate-400">{appliedCount}</span>}</button>
    {open && <dialog ref={dialogRef} id="skills-manager" role="dialog" aria-label="项目 Skills" aria-describedby="skills-description" className="session-settings-dialog"
      onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.currentTarget === event.target) close(); }}>
      <div className="session-settings-panel">
        <div className="session-settings-heading"><div><h2>项目 Skills</h2><p id="skills-description">管理此项目的技能与版本。</p></div>
          <button type="button" className="session-close-button" aria-label="关闭 Skills" autoFocus onClick={close}><XIcon className="h-5 w-5" /></button></div>
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
            <p className="break-all font-medium text-slate-700">{binding.connected ? "当前会话项目" : "待连接项目"}：{library?.projectPath ?? (binding.project || "尚未配置")}</p>
            <p className="mt-1 break-all">后端：{binding.config.baseUrl || "尚未配置"}</p>
            {binding.connected && <p className="mt-1">当前会话已应用 {appliedCount} 个技能 · 修订 {appliedRevision}</p>}
            <p className="mt-2">{SKILLS_REFRESH_HINT}</p>
          </div>
          {!ready && <p role="status" className="text-sm text-slate-500">请先在会话配置中填写项目、后端地址与 Token，再打开 Skills。</p>}
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}
          {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
          {ready && <>
            <section aria-label="技能库"><div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">项目技能库 <span className="font-normal text-slate-400">{library ? `修订 ${library.revision}` : ""}</span></h3>
              <Button size="sm" variant="ghost" loading={loading} disabled={busy} onClick={() => void refresh()}>刷新技能</Button></div>
              {loading && !library && <p role="status" className="text-sm text-slate-500">正在加载技能…</p>}
              {library && !groups.size && <p className="text-sm text-slate-500">尚未导入技能。上传文件、填写 URL 或选择本地候选开始。</p>}
              <div className="space-y-3">{[...groups].map(([id, versions]) => {
                const enabled = versions.find((skill) => skill.enabled);
                const selected = enabled ?? versions[0];
                return <SkillRow key={id} versions={versions} selected={selected} enabled={!!enabled} busy={busy || loading}
                  onChange={(isEnabled, version) => void change(selected, isEnabled, version)} />;
              })}</div>
            </section>
            <fieldset disabled={busy || loading} className="m-0 min-w-0 space-y-3 border-0 border-t border-slate-200 px-0 pt-4">
              <legend className="text-sm font-semibold text-slate-800">导入技能</legend>
              <label className="block text-xs font-medium text-slate-600">上传 SKILL.md 或单技能 ZIP
                <input type="file" aria-label="上传技能文件" accept=".md,.zip,text/markdown,application/zip" className="mt-2 block w-full rounded-lg border border-slate-200 bg-white p-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-slate-600"
                  onChange={(event) => {
                    const file = event.target.files?.[0]; event.target.value = "";
                    if (file) void prepare({ file });
                  }} />
              </label>
              <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (urlValid && !busy && !loading) void prepare({ url: url.trim() }); }}>
                <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">公开 HTTPS / GitHub 目录 URL
                  <input type="url" aria-label="技能 URL" value={url} placeholder="https://…/SKILL.md" className="session-input mt-2" onChange={(event) => setUrl(event.target.value)} /></label>
                <Button type="submit" size="sm" loading={busy} disabled={!urlValid || loading}>预览 URL</Button>
              </form>
              {url.trim() && !urlValid && <p className="text-xs text-amber-700">请输入不含账号或密码的公开 HTTPS URL。</p>}
            </fieldset>
            {preview && <div ref={previewRef}><SkillPreviewCard key={preview.id} preview={preview} confirmed={confirmed} onConfirm={confirm} onCancel={() => setPreview(null)} /></div>}
            <section aria-label="本地候选" className="border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-800">本地候选</h3>
              <p className="mt-1 text-xs text-slate-500">发现的 pi / .agents 技能需要预览并确认后才会启用。</p>
              {library && !library.local.length && <p className="mt-3 text-sm text-slate-400">未发现本地候选。</p>}
              <div className="mt-3 max-h-72 space-y-3 overflow-y-auto">{library?.local.map((candidate) => <div key={candidate.localId} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3">
                <div className="min-w-0"><p className="text-sm font-medium text-slate-800">{candidate.name}</p><p className="mt-1 text-xs text-slate-500">{candidate.description}</p><p className="mt-1 break-all text-xs text-slate-400">{candidate.source}</p></div>
                <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void prepare({ localId: candidate.localId })}>预览 {candidate.name}</Button>
              </div>)}</div>
            </section>
          </>}
        </div>
      </div>
    </dialog>}
  </>;
}

function SkillRow({ versions, selected, enabled, busy, onChange }: {
  versions: SkillLibrary["installed"]; selected: SkillVersion; enabled: boolean; busy: boolean;
  onChange: (enabled: boolean, version: string) => void;
}) {
  const [version, setVersion] = useState(selected.version);
  const skill = versions.find((item) => item.version === version) ?? selected;
  useEffect(() => {
    // The newest installed fallback is not a new project selection after disable.
    if (enabled) setVersion(selected.version);
  }, [enabled, selected.version]);
  return <article className="rounded-xl border border-slate-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-slate-800">{skill.name}</h4><span className={`rounded px-2 py-0.5 text-xs ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{enabled ? "已启用" : "未启用"}</span></div>
    <p className="mt-1 text-xs text-slate-500">{skill.description}</p>
    <p className="mt-1 break-all text-xs text-slate-400">来源：{skill.source.label}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2"><label className="min-w-0 flex-1 text-xs text-slate-500">版本
      <select aria-label={`${skill.name} 版本`} disabled={busy} value={skill.version} onChange={(event) => setVersion(event.target.value)} className="ml-2 max-w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
        {versions.map((item) => <option key={item.version} value={item.version}>{item.version}{item.enabled ? "（启用中）" : ""}</option>)}
      </select></label>
      {enabled && skill.version === selected.version
        ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange(false, skill.version)}>停用 {skill.name}</Button>
        : <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange(true, skill.version)}>{enabled ? "切换并启用" : "启用"} {skill.name}</Button>}
    </div>
  </article>;
}

function publicHttpsUrl(value: string): boolean {
  try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "请求失败，请重试。"; }
