import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HistorySessionInfo, ModelInfo } from "../api/client";
import type { SavedConfiguration } from "../config-history";
import { Button } from "./Button";
import { ChevronDownIcon, PlusIcon, RobotAvatar, XIcon } from "./Icons";

export type ModelStatus = "missing-token" | "missing-url" | "loading" | "ready" | "empty" | "error";
export type SessionMode = "new" | "history";
export type HistoryStatus = "missing-token" | "missing-url" | "missing-project" | "loading" | "ready" | "error";
export type ModelMode = "backend" | "custom";

const modelPlaceholders: Record<ModelStatus, string> = {
  "missing-token": "请先填写 Token",
  "missing-url": "请先填写后端地址",
  loading: "正在加载模型…",
  ready: "请选择模型",
  empty: "暂无可用模型",
  error: "模型加载失败",
};

export interface ConfigBarProps {
  baseUrl: string;
  token: string;
  project: string;
  sessionMode: SessionMode;
  histories: HistorySessionInfo[];
  historyStatus: HistoryStatus;
  historyError?: string;
  historyId: string;
  releasingHistoryId: string | null;
  savedConfigurations: SavedConfiguration[];
  configStorageError: string;
  onRestoreConfiguration: (entry: SavedConfiguration) => void;
  onClearConfigurations: () => void;
  model: string;
  models: ModelInfo[];
  modelStatus: ModelStatus;
  modelError?: string;
  modelMode: ModelMode;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmUrlInvalid: boolean;
  canConnect: boolean;
  connecting: boolean;
  connected: boolean;
  modelLabel: string | null;
  onBaseUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onProjectChange: (v: string) => void;
  onSessionModeChange: (v: SessionMode) => void;
  onHistorySelect: (id: string) => void;
  onHistoryRefresh: () => void;
  onHistoryRelease: (session: HistorySessionInfo) => Promise<void>;
  onModelChange: (v: string) => void;
  onModelModeChange: (v: ModelMode) => void;
  onLlmBaseUrlChange: (v: string) => void;
  onLlmApiKeyChange: (v: string) => void;
  onLlmModelChange: (v: string) => void;
  onConnect: () => Promise<boolean>;
  onNewSession: () => void;
  skillsControl?: ReactNode;
}

export function ConfigBar(props: ConfigBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [releaseCandidate, setReleaseCandidate] = useState<HistorySessionInfo | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [activeProject, setActiveProject] = useState(props.connected ? props.project.trim() : "");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const busy = props.connecting || !!props.releasingHistoryId;
  const candidates = (field: "project" | "baseUrl" | "llmBaseUrl" | "llmModel") => [...new Set(props.savedConfigurations.map(entry => entry[field]).filter(Boolean))];

  useEffect(() => {
    setReleaseCandidate(null);
    setReleaseError("");
  }, [props.baseUrl, props.token, props.project, props.sessionMode, expanded]);

  const releaseHistory = async () => {
    if (!releaseCandidate || busy) return;
    setReleaseError("");
    try {
      await props.onHistoryRelease(releaseCandidate);
      setReleaseCandidate(null);
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : "退出失败，请重试。");
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded) dialog?.showModal();
    return () => dialog?.close();
  }, [expanded]);

  useEffect(() => {
    setConnectError("");
  }, [props.baseUrl, props.token, props.project, props.sessionMode, props.historyId,
    props.modelMode, props.model, props.llmBaseUrl, props.llmApiKey, props.llmModel]);

  const openSession = (mode: SessionMode) => {
    props.onSessionModeChange(mode);
    setExpanded(true);
  };
  const closeSettings = () => {
    dialogRef.current?.close();
    setExpanded(false);
    setShowToken(false);
    setConnectError("");
    triggerRef.current?.focus();
  };
  const connect = async () => {
    const project = props.project.trim();
    setConnectError("");
    try {
      if (await props.onConnect()) {
        setActiveProject(project);
        closeSettings();
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "建会话失败，请检查配置后重试。");
    }
  };
  const projectName = activeProject.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || activeProject;
  const modelHint = props.modelStatus === "error"
    ? props.modelError
    : props.modelStatus === "empty"
      ? "后端暂无可用模型，请检查后端的模型凭据配置。"
      : props.modelStatus === "ready"
        ? `已从后端加载 ${props.models.length} 个可用模型`
        : props.modelStatus === "missing-token"
          ? "请填写后端启动时的 Token（--token 参数或启动日志）。"
          : modelPlaceholders[props.modelStatus];

  return (
    <>
      <header className="session-toolbar">
        <div className="session-brand">
          <RobotAvatar className="h-8 w-8 rounded-lg" />
          <span>code-analyzer</span>
        </div>
        <div className="session-context">
          {props.connected ? (
            <>
              <span className="session-project" title={activeProject}>{projectName}</span>
              <span className="session-context-divider" aria-hidden="true">/</span>
              <span className="session-model" title={props.modelLabel ?? undefined}>{props.modelLabel}</span>
            </>
          ) : <span className="session-idle-hint">只读代码分析助手</span>}
        </div>
        <div className="session-actions">
          {props.skillsControl}
          <span className={`session-status ${props.connected ? "is-connected" : ""}`}
            title={props.connected ? "已连接" : "未连接"}>
            <span aria-hidden="true" />{props.connected ? "已连接" : "未连接"}
          </span>
          <button type="button" className="session-new-button" title="新建会话" aria-label="新建会话" disabled={busy}
            onClick={() => { if (props.connected) props.onNewSession(); openSession("new"); }}>
            <PlusIcon className="h-4 w-4" />新建会话
          </button>
          <button type="button" className="session-new-button session-history-button" title="历史会话" aria-label="历史会话"
            disabled={busy} onClick={() => openSession("history")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
              <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2" />
            </svg>
            历史会话
          </button>
          <button ref={triggerRef} type="button" className="session-config-button"
            aria-label="会话配置" aria-expanded={expanded} aria-haspopup="dialog"
            aria-controls={expanded ? "session-settings" : undefined}
            onClick={() => { if (props.sessionMode === "history") props.onHistoryRefresh(); setExpanded(true); }}>
            会话配置<ChevronDownIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      {expanded && (
        <dialog ref={dialogRef} id="session-settings" role="dialog" aria-label="会话配置"
          aria-describedby="session-settings-description" className="session-settings-dialog"
          onCancel={(event) => { event.preventDefault(); closeSettings(); }}
          onClick={(event) => { if (event.target === event.currentTarget) closeSettings(); }}>
          <div className="session-settings-panel">
            <div className="session-settings-heading">
              <div>
                <h2>会话配置</h2>
                <p id="session-settings-description">选择项目与模型，开始代码分析。</p>
              </div>
              <button type="button" aria-label="关闭配置" className="session-close-button"
                autoFocus onClick={closeSettings}><XIcon className="h-5 w-5" /></button>
            </div>

            <div className="session-settings-body">
              <fieldset className="session-settings-section" disabled={busy}>
                <legend>本地配置记录</legend>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span>最近 {props.savedConfigurations.length} 组成功连接的配置</span>
                  <button type="button" className="border-0 bg-transparent px-0 py-1 text-slate-500 hover:text-rose-600 disabled:opacity-40"
                    disabled={!props.savedConfigurations.length} onClick={props.onClearConfigurations}>清空配置记录</button>
                </div>
                {props.savedConfigurations.length > 0 ? (
                  <label className="session-field"><span>选择历史配置，一键回填</span>
                    <select className="session-input" aria-label="选择历史配置" value="" onChange={(event) => {
                      const entry = props.savedConfigurations.find(item => item.id === event.target.value);
                      if (entry) props.onRestoreConfiguration(entry);
                    }}>
                      <option value="" disabled>选择一组配置…</option>
                      {props.savedConfigurations.map(entry => <option key={entry.id} value={entry.id}>
                        {entry.project} · {entry.modelMode === "custom" ? `${entry.llmModel} @ ${entry.llmBaseUrl}` : entry.model} · {entry.baseUrl}
                      </option>)}
                    </select>
                  </label>
                ) : <p className="session-field-hint">成功连接后自动记录，最多保留 10 组；下次打开页面会预填上次配置。</p>}
                <p className="session-field-hint">仅保存在当前浏览器。不保存 Token 和 API Key，回填后需重新填写凭据；不会自动创建会话。</p>
                {props.configStorageError && <p role="status" className="session-field-hint is-error">{props.configStorageError}</p>}
              </fieldset>
              <datalist id="config-project-history">{candidates("project").map(value => <option key={value} value={value} />)}</datalist>
              <datalist id="config-backend-history">{candidates("baseUrl").map(value => <option key={value} value={value} />)}</datalist>
              <datalist id="config-llm-url-history">{candidates("llmBaseUrl").map(value => <option key={value} value={value} />)}</datalist>
              <datalist id="config-llm-model-history">{candidates("llmModel").map(value => <option key={value} value={value} />)}</datalist>
              <fieldset className="session-settings-section" disabled={busy}>
                <legend>分析项目</legend>
                <label className="session-field">
                  <span>项目路径或 Git URL</span>
                  <input className="session-input" placeholder="项目路径 或 git URL" aria-label="项目路径 或 git URL" list="config-project-history" autoComplete="off"
                    value={props.project} onChange={(event) => props.onProjectChange(event.target.value)} />
                </label>
                <div className="session-model-modes session-start-modes">
                  <label className={props.sessionMode === "new" ? "is-selected" : ""}>
                    <input type="radio" name="session-mode" value="new" checked={props.sessionMode === "new"}
                      onChange={() => props.onSessionModeChange("new")} />
                    新建会话
                  </label>
                  <label className={props.sessionMode === "history" ? "is-selected" : ""}>
                    <input type="radio" name="session-mode" value="history" checked={props.sessionMode === "history"}
                      onChange={() => props.onSessionModeChange("history")} />
                    从历史继续
                  </label>
                </div>
                {props.sessionMode === "history" && (
                  <div className="session-history">
                    <div className="session-history-heading">
                      <span>选择要继续的会话</span>
                      <button type="button" className="session-history-refresh" onClick={props.onHistoryRefresh}
                        disabled={busy || ["loading", "missing-token", "missing-url", "missing-project"].includes(props.historyStatus)}>
                        刷新列表
                      </button>
                    </div>
                    {props.historyStatus === "ready" && props.histories.length > 0 ? (
                      <div className="session-history-list" role="radiogroup" aria-label="选择历史记录">
                        {props.histories.map((session) => (
                          <div key={session.id} className={`session-history-item ${props.historyId === session.id ? "is-selected" : ""} ${session.active ? "is-active" : ""}`}>
                            <label className="flex min-w-0 flex-1 cursor-inherit items-center gap-3">
                              <input type="radio" name="history-session" value={session.id} checked={props.historyId === session.id}
                                disabled={busy || !!session.active} onChange={() => props.onHistorySelect(session.id)} />
                              <span className="session-history-info">
                                <span className="session-history-title">{session.title || "未命名会话"}</span>
                                <span className="session-history-meta">
                                  <time dateTime={session.updatedAt}>{formatHistoryDate(session.updatedAt)}</time>
                                  <span>{session.messageCount} 条消息</span>
                                  {session.modelLabel && <span title={session.modelLabel}>{session.modelLabel}</span>}
                                </span>
                              </span>
                            </label>
                            {session.active && (
                              <div className="flex shrink-0 flex-col items-end gap-1.5">
                                <span className="session-history-badge">使用中</span>
                                {session.activeSessionId && (
                                  <button type="button" disabled={busy}
                                    className="rounded-md border-0 bg-transparent px-1 py-1 text-xs text-slate-600 hover:bg-slate-100 hover:text-rose-600 disabled:cursor-wait"
                                    title="退出运行中的会话并保留历史记录"
                                    onClick={() => { setReleaseCandidate(session); setReleaseError(""); }}>
                                    {props.releasingHistoryId === session.id ? "正在退出…" : "退出会话"}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={`session-history-empty ${props.historyStatus === "error" ? "is-error" : ""}`}
                        role={props.historyStatus === "error" ? "alert" : "status"}>
                        {props.historyStatus === "missing-token" ? "填写下方后端 Token 后查看历史会话。"
                          : props.historyStatus === "missing-url" ? "填写下方后端地址后查看历史会话。"
                            : props.historyStatus === "missing-project" ? "请先填写项目路径或 Git URL。"
                              : props.historyStatus === "loading" ? "正在加载历史会话…"
                                : props.historyStatus === "error" ? props.historyError
                                  : "这个项目还没有历史会话，可以先新建会话开始分析。"}
                      </div>
                    )}
                    {releaseCandidate && (
                      <div className="mt-3 rounded-lg border border-solid border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-slate-600">
                        <p className="m-0">确认退出「{releaseCandidate.title}」？这会中止正在生成的回复，并断开使用它的窗口；保留历史记录。</p>
                        {releaseError && <p role="alert" className="mt-2 mb-0 break-words text-rose-600">{releaseError}</p>}
                        <div className="mt-2 flex justify-end gap-2">
                          <button type="button" className="rounded-md border-0 bg-transparent px-2 py-1.5 text-slate-600 hover:bg-amber-100"
                            disabled={busy} onClick={() => { setReleaseCandidate(null); setReleaseError(""); }}>取消</button>
                          <button type="button" className="rounded-md border-0 bg-rose-600 px-3 py-1.5 text-white hover:bg-rose-700 disabled:opacity-50"
                            disabled={busy} onClick={() => { void releaseHistory(); }}>{props.releasingHistoryId ? "正在退出…" : "确认退出"}</button>
                        </div>
                      </div>
                    )}
                    <p className="session-field-hint">使用下方模型配置继续；历史会话不会恢复 API Key。页面刷新时会尝试自动退出；遗留的使用中会话可手动退出后恢复。</p>
                  </div>
                )}
              </fieldset>

              <fieldset className="session-settings-section" disabled={busy}>
                <legend>分析服务</legend>
                <div className="session-fields-grid">
                  <label className="session-field">
                    <span>后端地址</span>
                    <input className="session-input" placeholder="后端地址" aria-label="后端地址" list="config-backend-history" autoComplete="off"
                      value={props.baseUrl} onChange={(event) => props.onBaseUrlChange(event.target.value)} />
                  </label>
                  <div className="session-field">
                    <label htmlFor="backend-token">后端 Token</label>
                    <div className="session-token-field">
                      <input id="backend-token" className="session-input" type={showToken ? "text" : "password"}
                        placeholder="Token" aria-label="后端 Token" autoComplete="off" value={props.token}
                        onChange={(event) => props.onTokenChange(event.target.value)} />
                      <button type="button" aria-label={showToken ? "隐藏后端 Token" : "显示后端 Token"}
                        aria-pressed={showToken} onClick={() => setShowToken((value) => !value)}>
                        {showToken ? "隐藏" : "显示"}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="session-field-hint">Token 使用后端启动时的值（--token 参数或启动日志）。</p>
              </fieldset>

              <fieldset className="session-settings-section" disabled={busy}>
                <legend>LLM 配置</legend>
                <div className="session-model-modes">
                  <label className={props.modelMode === "backend" ? "is-selected" : ""}>
                    <input type="radio" name="model-mode" value="backend" checked={props.modelMode === "backend"}
                      onChange={() => props.onModelModeChange("backend")} />
                    后端模型
                  </label>
                  <label className={props.modelMode === "custom" ? "is-selected" : ""}>
                    <input type="radio" name="model-mode" value="custom" checked={props.modelMode === "custom"}
                      onChange={() => props.onModelModeChange("custom")} />
                    自定义 OpenAI 兼容接口
                  </label>
                </div>
                {props.modelMode === "custom" ? (
                  <>
                    <label className="session-field">
                      <span>LLM BaseURL</span>
                      <input className="session-input" placeholder="LLM BaseURL" aria-label="LLM BaseURL" list="config-llm-url-history"
                        value={props.llmBaseUrl} onChange={(event) => props.onLlmBaseUrlChange(event.target.value)}
                        aria-invalid={props.llmUrlInvalid} aria-describedby="llm-config-hint" autoComplete="off" />
                    </label>
                    <div className="session-fields-grid session-custom-fields">
                      <label className="session-field">
                        <span>模型名</span>
                        <input className="session-input" placeholder="模型名" aria-label="模型名" autoComplete="off" list="config-llm-model-history"
                          value={props.llmModel} onChange={(event) => props.onLlmModelChange(event.target.value)} />
                      </label>
                      <label className="session-field">
                        <span>LLM API Key <span className="session-optional">可选</span></span>
                        <input className="session-input" placeholder="LLM API Key（可选）" aria-label="LLM API Key（可选）"
                          type="password" autoComplete="off" value={props.llmApiKey}
                          onChange={(event) => props.onLlmApiKeyChange(event.target.value)} />
                      </label>
                    </div>
                    <p id="llm-config-hint" role={props.llmUrlInvalid ? "alert" : "status"}
                      className={`session-field-hint ${props.llmUrlInvalid ? "is-error" : ""}`}>
                      {props.llmUrlInvalid
                        ? "LLM BaseURL 需为 http:// 或 https:// 地址，且不含用户名、密码、查询参数或 # 片段。"
                        : "BaseURL 示例：http://localhost:11434/v1；模型名示例：org/model。API Key 仅用于本次会话，不持久化保存。"}
                    </p>
                    {!props.token.trim() && <p role="status" className="session-field-hint">请先填写分析服务的后端 Token。</p>}
                  </>
                ) : (
                  <>
                    <label className="session-field">
                      <span>模型</span>
                      <select className="session-input" aria-label="后端模型" value={props.model}
                        onChange={(event) => props.onModelChange(event.target.value)}
                        disabled={props.connecting || props.modelStatus !== "ready"}>
                        {!props.models.length && <option value="">{modelPlaceholders[props.modelStatus]}</option>}
                        {props.models.map((model) => (
                          <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p role={props.modelStatus === "error" ? "alert" : "status"}
                      className={`session-field-hint ${props.modelStatus === "error" ? "is-error" : ""}`}>{modelHint}</p>
                  </>
                )}
              </fieldset>
            </div>

            {connectError && <div role="alert" className="session-connect-error">{connectError}</div>}
            <div className="session-settings-footer">
              <span>{props.sessionMode === "history" ? (props.historyId ? "继续时会加载历史消息与上下文" : "请选择一条历史会话")
                : props.connected ? "配置修改后，重新建会话生效" : "建会话成功后，面板自动收起"}</span>
              <Button type="button" aria-label="连接会话" loading={props.connecting} disabled={!props.canConnect} onClick={connect}>
                {props.sessionMode === "history" ? "继续所选会话" : "建会话"}
              </Button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}


function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
  }).format(date);
}
