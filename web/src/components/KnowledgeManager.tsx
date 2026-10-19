import { useEffect, useRef, useState } from "react";
import { getKnowledge, listKnowledge, previewKnowledgeEvidence, reviewKnowledge } from "../api/client";
import type { KnowledgeItem, MemoryLibrary, ReviewInput, SourceEvidenceInput, SourceEvidence, SourceSnapshot } from "../types";
import type { SkillsBinding } from "./SkillsManager";
import { Button } from "./Button";
import { BookOpenIcon, XIcon } from "./Icons";

const tabs = [{ state: "candidate", label: "候选" }, { state: "published", label: "已发布" }, { state: "needsreview", label: "待复核" }];
const states: Record<string, string> = { candidate: "候选", published: "已发布", suspended: "已暂停", superseded: "旧版本", withdrawn: "已撤回" };
const PAGE_SIZE = 20;

/** App remounts this control for each actual session/backend/project binding. */
export function KnowledgeManager({ binding }: { binding: SkillsBinding }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("candidate");
  const [offset, setOffset] = useState(0);
  const [library, setLibrary] = useState<MemoryLibrary | null>(null);
  const [item, setItem] = useState<KnowledgeItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const operation = useRef(0);
  const pending = useRef(false);
  const ready = !!binding.project && !!binding.config.baseUrl && !!binding.config.token;
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  useEffect(() => { const dialog = dialogRef.current; if (open) dialog?.showModal(); return () => dialog?.close(); }, [open]);
  const close = () => { operation.current++; setOpen(false); setLoading(false); dialogRef.current?.close(); triggerRef.current?.focus(); };
  const errorText = (failure: unknown) => failure instanceof Error ? failure.message : "请求失败，请重试。";
  const load = async (nextState = state, nextOffset = offset) => {
    if (!ready || pending.current) return;
    const id = ++operation.current;
    setState(nextState); setOffset(nextOffset); setLoading(true); setError(""); setItem(null); setLibrary(null); setNotice("");
    try {
      const result = await listKnowledge(binding.config, binding.project, nextState, PAGE_SIZE, nextOffset);
      if (!alive.current || id !== operation.current) return;
      if (binding.connected && result.projectPath !== binding.project) throw new Error("知识库所属项目不匹配，请重新打开。");
      setLibrary(result);
    } catch (failure) { if (alive.current && id === operation.current) setError(errorText(failure)); }
    finally { if (alive.current && id === operation.current) setLoading(false); }
  };
  const detail = async (id: string) => {
    if (pending.current) return;
    const request = ++operation.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await getKnowledge(binding.config, id);
      if (!alive.current || request !== operation.current) return;
      if (result.snapshot.projectPath !== (library?.projectPath ?? binding.project)) throw new Error("知识详情所属项目不匹配。");
      setItem(result);
    } catch (failure) { if (alive.current && request === operation.current) setError(errorText(failure)); }
    finally { if (alive.current && request === operation.current) setLoading(false); }
  };
  const review = async (selected: KnowledgeItem, input: ReviewInput) => {
    if (pending.current || loading) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    const request = ++operation.current;
    try {
      const result = await reviewKnowledge(binding.config, selected.id, input);
      if (!alive.current || request !== operation.current) return;
      if (result.snapshot.projectPath !== selected.snapshot.projectPath) throw new Error("审核结果所属项目不匹配。");
      setItem(result);
      setLibrary((previous) => previous ? { ...previous, items: previous.items.map((entry) => entry.id === result.id ? result : entry) } : previous);
      setNotice("知识状态已更新。代码或已用知识变化后，请新建会话。 ");
    } catch (failure) { if (alive.current && request === operation.current) setError(errorText(failure)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <>
    <button ref={triggerRef} type="button" className="session-new-button" aria-label="知识库管理" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "knowledge-manager" : undefined}
      onClick={() => { setOpen(true); void load(); }}><BookOpenIcon className="h-4 w-4" />知识库</button>
    {open && <dialog ref={dialogRef} id="knowledge-manager" role="dialog" aria-label="项目知识库" aria-describedby="knowledge-description" className="session-settings-dialog"
      onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="session-settings-panel"><div className="session-settings-heading"><div><h2>项目知识库</h2><p id="knowledge-description">人工审核后发布，复用同一代码版本的可靠结论。</p></div>
        <button type="button" className="session-close-button" aria-label="关闭知识库" autoFocus onClick={close}><XIcon className="h-5 w-5" /></button></div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-500"><p className="break-all font-medium text-slate-700">{binding.connected ? "当前会话项目" : "待连接项目"}：{library?.projectPath ?? (binding.project || "尚未配置")}</p><p className="mt-1 break-all">后端：{binding.config.baseUrl || "尚未配置"}</p><p className="mt-2">点赞与手动收录只创建候选；发布需要适用条件与源码证据。</p></div>
          {!ready && <p role="status" className="text-sm text-slate-500">请先填写项目、后端地址与 Token。</p>}
          {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}<p className="mt-1 text-xs">若后端不支持记忆功能，可继续普通代码分析。版本冲突时请刷新详情再审核。</p></div>}
          {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
          {ready && <>
            <div role="tablist" aria-label="知识状态" className="flex gap-1 border-b border-slate-200 pb-2">{tabs.map((tab) => <button type="button" key={tab.state} role="tab" aria-selected={state === tab.state} disabled={busy} className={`knowledge-tab rounded-lg border-0 px-3 py-2 text-sm ${state === tab.state ? "bg-indigo-50 font-medium text-indigo-700" : "bg-transparent text-slate-500 hover:bg-slate-100"}`} onClick={() => void load(tab.state, 0)}>{tab.label}</button>)}</div>
            {loading && <p role="status" className="text-sm text-slate-500">正在加载知识…</p>}
            {library && <>
              {!library.indexAvailable && <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">搜索索引不可用，知识仍可审核。{library.indexError}</p>}
              {!library.snapshot.clean && <p className="text-xs text-amber-700">当前代码无法复用知识：{library.snapshot.reason ?? "工作区存在修改"}</p>}
              <div className="flex items-center justify-between text-xs text-slate-500"><span>共 {library.total} 条 · 当前代码 {library.snapshot.branch} · {library.snapshot.commit.slice(0, 12)}</span><Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void load()}>刷新知识库</Button></div>
              {!library.items.length && !loading && <p role="status" className="py-4 text-sm text-slate-500">暂无{tabs.find((tab) => tab.state === state)?.label}知识。可在回答旁收录候选。</p>}
              <div className="space-y-2">{library.items.map((entry) => <button key={entry.id} type="button" aria-label={entry.question} data-selected={entry.id === item?.id} disabled={busy || loading} className={`knowledge-list-row block w-full rounded-xl border p-3 text-left ${entry.id === item?.id ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200 hover:border-indigo-200"}`} onClick={() => void detail(entry.id)}><span className="block text-sm font-medium text-slate-800">{entry.question}</span><span className="mt-1 block text-xs text-slate-500">{states[entry.state]} · 修订 {entry.revision} · ↑ {entry.up} ↓ {entry.down}{entry.applicable === false ? " · 当前代码不适用" : ""}</span></button>)}</div>
              <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy || loading || offset === 0} onClick={() => void load(state, Math.max(0, offset - PAGE_SIZE))}>上一页</Button><Button size="sm" variant="ghost" disabled={busy || loading || offset + PAGE_SIZE >= library.total} onClick={() => void load(state, offset + PAGE_SIZE)}>下一页</Button></div>
            </>}
            {item && <KnowledgeEditor key={`${item.id}:${item.revision}`} item={item} currentSource={library?.snapshot ?? item.snapshot} busy={busy || loading} onRefresh={() => void detail(item.id)} onPreview={(input) => previewKnowledgeEvidence(binding.config, item.id, input)} onReview={(input) => void review(item, input)} />}
          </>}
        </div>
      </div>
    </dialog>}
  </>;
}

function KnowledgeEditor({ item, currentSource, busy, onRefresh, onPreview, onReview }: { item: KnowledgeItem; currentSource: SourceSnapshot; busy: boolean; onRefresh: () => void; onPreview: (input: { expectedRevision: number; expectedSourceKey: string; evidence: SourceEvidenceInput[] }) => Promise<{ snapshot: SourceSnapshot; evidence: SourceEvidence[] }>; onReview: (input: ReviewInput) => void }) {
  const [question, setQuestion] = useState(item.question);
  const [answer, setAnswer] = useState(item.answer);
  const [conditions, setConditions] = useState(item.conditions);
  const [evidence, setEvidence] = useState<SourceEvidenceInput[]>(item.evidence.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })));
  const [revalidate, setRevalidate] = useState(false);
  const [preview, setPreview] = useState<{ key: string; evidence: SourceEvidence[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sourceChanged = currentSource.key !== item.snapshot.key || !item.snapshot.clean;
  const evidenceKey = JSON.stringify([currentSource.key, evidence]);
  const verified = preview?.key === evidenceKey;
  const valid = !!question.trim() && !!answer.trim() && !!conditions.trim() && evidence.length > 0 && evidence.every((entry) => entry.path.trim() && Number.isSafeInteger(entry.startLine) && entry.startLine > 0 && Number.isSafeInteger(entry.endLine) && entry.endLine >= entry.startLine);
  const submit = (action: ReviewInput["action"]) => onReview({ expectedRevision: item.revision, action,
    ...(["publish", "revise"].includes(action) ? { question, answer, conditions, evidence, expectedSourceKey: currentSource.key, ...(sourceChanged ? { revalidate } : {}) } : {}),
  });
  const changeEvidence = (index: number, input: Partial<SourceEvidenceInput>) => setEvidence((current) => current.map((entry, i) => i === index ? { ...entry, ...input } : entry));
  return <section aria-label="知识详情" className="space-y-4 border-t border-slate-200 pt-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-800">知识详情 · {states[item.state]} · 修订 {item.revision}</h3><Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>刷新知识详情</Button></div>
    <div className="space-y-1 break-all rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-500"><p>版本：{item.versionId}</p><p>分支：{item.snapshot.branch}</p><p>提交：{item.snapshot.commit}</p><p>来源回答：{item.sourceAnswerId}</p><p>策略：{item.policyHash}</p></div>
    {sourceChanged && <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><input type="checkbox" aria-label="在当前代码版本重新核验" checked={revalidate} onChange={event => setRevalidate(event.target.checked)} /><span>在当前代码版本重新核验并发布：{currentSource.branch}@{currentSource.commit.slice(0, 12)}。请重新确认结论与适用条件。</span></label>}
    <fieldset disabled={busy || previewing || item.state === "withdrawn" || item.state === "superseded"} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <label className="block text-xs font-medium text-slate-600">问题<textarea aria-label="知识问题" className="session-input mt-1" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
      <label className="block text-xs font-medium text-slate-600">回答<textarea aria-label="知识回答" className="session-input mt-1" rows={6} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>
      <label className="block text-xs font-medium text-slate-600">适用条件<textarea aria-label="适用条件" className="session-input mt-1" rows={3} placeholder="说明适用范围、前提及不适用的情况" value={conditions} onChange={(event) => setConditions(event.target.value)} /></label>
      <div className="space-y-3"><p className="text-xs font-semibold text-slate-700">源码证据</p><p className="text-xs text-slate-500">填写该提交中的文件与行号；发布时由服务端读取固定 Git 内容。下方快照不可编辑。</p>
        {evidence.map((entry, index) => <div key={index} className="space-y-2 rounded-lg border border-slate-200 p-3"><label className="block text-xs text-slate-600">文件路径<input aria-label={`证据 ${index + 1} 文件`} className="session-input mt-1" value={entry.path} onChange={(event) => changeEvidence(index, { path: event.target.value })} /></label>
          <div className="flex gap-2">{(["startLine", "endLine"] as const).map((field) => <label key={field} className="min-w-0 flex-1 text-xs text-slate-600">{field === "startLine" ? "起始行" : "结束行"}<input type="number" min={1} step={1} aria-label={`证据 ${index + 1} ${field === "startLine" ? "起始行" : "结束行"}`} className="session-input mt-1" value={entry[field]} onChange={(event) => changeEvidence(index, { [field]: Number(event.target.value) })} /></label>)}</div>
          <button type="button" className="knowledge-remove-evidence border-0 bg-transparent text-xs text-slate-500 hover:text-red-600" onClick={() => setEvidence((current) => current.filter((_, i) => i !== index))}>移除证据 {index + 1}</button>
        </div>)}<Button size="sm" variant="ghost" onClick={() => setEvidence((current) => [...current, { path: "", startLine: 1, endLine: 1 }])}>添加源码证据</Button>
      </div>
      {!valid && <p className="text-xs text-amber-700">发布或修订需要完整的问题、回答、适用条件及有效的源码行号。</p>}
      <Button size="sm" variant="ghost" disabled={busy || !valid || !currentSource.clean} onClick={() => {
        const key = evidenceKey; setPreviewing(true); setPreviewError("");
        void onPreview({ expectedRevision: item.revision, expectedSourceKey: currentSource.key, evidence }).then(result => {
          if (alive.current) setPreview({ key, evidence: result.evidence });
        }).catch(failure => { if (alive.current) setPreviewError(failure instanceof Error ? failure.message : "源码核验失败"); }).finally(() => { if (alive.current) setPreviewing(false); });
      }}>核验源码</Button>
      {previewError && <p role="alert" className="text-xs text-red-600">{previewError}</p>}
      {!verified && <p className="text-xs text-slate-500">先核验并阅读固定版本源码，再发布知识。修改证据行号后需要重新核验。</p>}
      <div className="flex flex-wrap gap-2">{["candidate", "suspended"].includes(item.state) && <Button size="sm" disabled={busy || !valid || !verified || !currentSource.clean || (sourceChanged && !revalidate)} onClick={() => submit("publish")}>发布知识</Button>}<Button size="sm" variant="ghost" disabled={busy || !valid || !verified || !currentSource.clean || (sourceChanged && !revalidate)} onClick={() => submit("revise")}>保存修订</Button>{item.state === "published" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => submit("suspend")}>暂停复用</Button>}<Button size="sm" variant="danger" disabled={busy} onClick={() => submit("withdraw")}>撤回知识</Button></div>
    </fieldset>
    {verified && <section aria-label="核验源码预览" className="space-y-2">{preview.evidence.map((entry, index) => <details key={index} open className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-3"><summary className="text-xs text-emerald-800">{entry.path}:{entry.startLine}–{entry.endLine} · {currentSource.commit.slice(0, 12)}</summary><pre className="mt-2 overflow-x-auto whitespace-pre text-xs text-slate-700">{entry.text}</pre></details>)}</section>}
    {!!item.feedback?.length && <section aria-label="匿名反馈详情" className="space-y-2"><h4 className="text-xs font-semibold text-slate-600">匿名反馈（含来源及历史版本）</h4>{item.feedback.map((entry, index) => <div key={index} className="rounded border border-slate-200 p-2 text-xs text-slate-600"><p>{entry.vote === "up" ? "有帮助" : "无帮助"}{entry.reason ? ` · ${{ incorrect: "事实错误", outdated: "内容过期", irrelevant: "答非所问", presentation: "表达问题" }[entry.reason]}` : ""}</p>{entry.comment && <p className="mt-1 whitespace-pre-wrap">{entry.comment}</p>}</div>)}</section>}
    {item.evidence.length > 0 && <div className="space-y-2"><h4 className="text-xs font-semibold text-slate-600">服务端固定源码快照</h4>{item.evidence.map((entry, index) => <details key={index} open className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer break-all text-xs text-slate-500">{entry.path}:{entry.startLine}–{entry.endLine} · blob {entry.blobHash}</summary><pre className="mt-2 overflow-x-auto whitespace-pre text-xs text-slate-700">{entry.text}</pre></details>)}</div>}
    {!!item.versions?.length && <details><summary className="cursor-pointer text-xs text-slate-500">历史版本（{item.versions.length}）</summary><div className="mt-2 space-y-2">{item.versions.map((version) => <div key={version.versionId} className="rounded border border-slate-200 p-2 text-xs text-slate-500"><p className="break-all">{version.versionId} · 修订 {version.revision} · {states[version.state]} · {version.snapshot.commit}</p><p className="mt-1 whitespace-pre-wrap">{version.answer}</p></div>)}</div></details>}
  </section>;
}
