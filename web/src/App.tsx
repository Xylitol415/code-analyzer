import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./hooks/useChat";
import { listHistory, listModels, type HistorySessionInfo, type ModelInfo, type ServerConfig } from "./api/client";
import { ConfigBar, type HistoryStatus, type SessionMode, type ModelMode, type ModelStatus } from "./components/ConfigBar";
import { ChatMessage } from "./components/ChatMessage";
import { MessageInput } from "./components/MessageInput";
import { ToastContainer, useToast } from "./components/Toast";
import { KnowledgeManager } from "./components/KnowledgeManager";
import { SkillsManager } from "./components/SkillsManager";
import { SparkleIcon } from "./components/Icons";
import { CONFIG_HISTORY_KEY, clearConfigurationHistory, loadConfigurationHistory, rememberConfiguration, saveConfigurationHistory, type SavedConfiguration } from "./config-history";

interface ModelDiscovery {
  config: ServerConfig;
  models: ModelInfo[];
  status: "ready" | "empty" | "error";
  error?: string;
}

interface HistoryDiscovery {
  scope: object;
  sessions: HistorySessionInfo[];
  error?: string;
}

export default function App() {
  const [savedConfigurations, setSavedConfigurations] = useState(loadConfigurationHistory);
  const initial = useRef(savedConfigurations[0]);
  const [configStorageError, setConfigStorageError] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial.current?.baseUrl ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [project, setProject] = useState(initial.current?.project ?? "");
  const [sessionMode, setSessionMode] = useState<SessionMode>("new");
  const [historyId, setHistoryId] = useState("");
  const [historyDiscovery, setHistoryDiscovery] = useState<HistoryDiscovery | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [model, setModel] = useState(initial.current?.model ?? "");
  const [modelMode, setModelMode] = useState<ModelMode>(initial.current?.modelMode ?? "backend");
  const [llmBaseUrl, setLlmBaseUrl] = useState(initial.current?.llmBaseUrl ?? "");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState(initial.current?.llmModel ?? "");
  const preferredModel = useRef({ baseUrl: initial.current?.baseUrl, model: initial.current?.model });
  const alive = useRef(true);
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [releasingHistoryId, setReleasingHistoryId] = useState<string | null>(null);

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedToken = token.trim();
  const config = useMemo(
    () => ({ baseUrl: normalizedBaseUrl, token: normalizedToken }),
    [normalizedBaseUrl, normalizedToken],
  );
  const chat = useChat(config);
  const { toasts, show } = useToast();
  const skillsConfig = chat.activeConfig ?? config;
  const skillsProject = chat.sessionId ? chat.projectPath ?? "" : project.trim();
  const skillsBinding = useMemo(() => ({
    config: skillsConfig, project: skillsProject, connected: !!chat.sessionId,
  }), [chat.sessionId, skillsConfig, skillsProject]);
  // A new binding owns a fresh dialog and revokes all pending preview/confirm UI.
  const skillsBindingKey = useMemo(() => crypto.randomUUID(), [skillsBinding]);
  // Only expose results belonging to the current address and token, even before
  // the effect cleanup runs after a configuration change.
  const currentDiscovery = discovery?.config === config ? discovery : null;
  const models = currentDiscovery?.models ?? [];
  const modelStatus: ModelStatus = !config.token
    ? "missing-token"
    : !config.baseUrl
      ? "missing-url"
      : currentDiscovery?.status ?? "loading";
  const modelReady = modelStatus === "ready" && models.some((m) => `${m.provider}/${m.id}` === model);
  let llmUrlValid = false;
  try {
    const url = new URL(llmBaseUrl.trim());
    llmUrlValid = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* An incomplete URL is expected while typing. */ }
  const selectionReady = modelMode === "backend" ? modelReady : llmUrlValid && !!llmModel.trim();
  const historyScope = useMemo(
    () => ({ config, project: project.trim(), revision: historyRevision }),
    [config, project.trim(), historyRevision],
  );
  const currentHistory = historyDiscovery?.scope === historyScope ? historyDiscovery : null;
  const histories = currentHistory?.sessions ?? [];
  const historyStatus: HistoryStatus = !config.token ? "missing-token"
    : !config.baseUrl ? "missing-url"
      : !project.trim() ? "missing-project"
        : !currentHistory ? "loading"
          : currentHistory.error ? "error" : "ready";
  const selectedHistory = histories.find((session) => session.id === historyId && !session.active);
  const canConnect = !!project.trim() && !!config.baseUrl && !!config.token && selectionReady
    && (sessionMode === "new" || !!selectedHistory) && !connecting && !releasingHistoryId;

  const refreshHistory = () => setHistoryRevision((revision) => revision + 1);
  const changeSessionMode = (mode: SessionMode) => {
    setSessionMode(mode);
    if (mode === "history") refreshHistory();
  };

  const releaseHistory = async (session: HistorySessionInfo) => {
    if (!session.activeSessionId || releasingHistoryId) return;
    setReleasingHistoryId(session.id);
    try {
      await chat.disconnect(session.activeSessionId, config);
      refreshHistory();
      show("success", "会话已退出，历史记录已保留");
    } finally {
      setReleasingHistoryId(null);
    }
  };

  useEffect(() => {
    alive.current = true;
    const sync = (event: StorageEvent) => {
      if (event.key === CONFIG_HISTORY_KEY || event.key === null) setSavedConfigurations(loadConfigurationHistory());
    };
    window.addEventListener("storage", sync);
    return () => { alive.current = false; window.removeEventListener("storage", sync); };
  }, []);

  const restoreConfiguration = (entry: SavedConfiguration) => {
    setBaseUrl(entry.baseUrl); setProject(entry.project); setModelMode(entry.modelMode);
    setModel(entry.model); setLlmBaseUrl(entry.llmBaseUrl); setLlmModel(entry.llmModel);
    preferredModel.current = { baseUrl: entry.baseUrl, model: entry.model };
    setToken(""); setLlmApiKey(""); setHistoryId("");
  };
  const clearConfigurations = () => {
    if (clearConfigurationHistory()) { setSavedConfigurations([]); setConfigStorageError(""); }
    else setConfigStorageError("本地存储不可用，无法清空配置记录。请检查浏览器存储权限。");
  };

  useEffect(() => {
    let cancelled = false;
    setHistoryId("");
    setHistoryDiscovery(null);
    if (sessionMode !== "history" || !config.token || !config.baseUrl || !historyScope.project) return;
    const timer = window.setTimeout(() => {
      listHistory(config, historyScope.project)
        .then((result) => {
          if (!cancelled) setHistoryDiscovery({ scope: historyScope, sessions: result.sessions });
        })
        .catch((error: unknown) => {
          if (!cancelled) setHistoryDiscovery({
            scope: historyScope,
            sessions: [],
            error: error instanceof Error ? error.message : "无法加载历史会话，请检查后端地址和服务状态。",
          });
        });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [config, historyScope, sessionMode]);

  // Debounce typing and keep authentication errors inline rather than toasting
  // once for each partially entered token.
  useEffect(() => {
    let cancelled = false;
    setModel("");
    setDiscovery(null);
    if (!config.token || !config.baseUrl) return;
    const timer = window.setTimeout(() => {
      listModels(config)
        .then((r) => {
          if (cancelled) return;
          const ids = r.models.map((m) => `${m.provider}/${m.id}`);
          setDiscovery({ config, models: r.models, status: ids.length ? "ready" : "empty" });
          const preferred = preferredModel.current.baseUrl === config.baseUrl ? preferredModel.current.model : undefined;
          setModel(preferred && ids.includes(preferred) ? preferred : ids.includes(r.default) ? r.default : ids[0] ?? "");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setDiscovery({
            config,
            models: [],
            status: "error",
            error: error instanceof Error ? error.message : "无法加载模型，请检查后端地址和服务状态。",
          });
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.messages]);

  const handleConnect = async () => {
    if (!canConnect) return false;
    setConnecting(true);
    const usedConfiguration = { project: project.trim(), baseUrl: config.baseUrl, modelMode, model, llmBaseUrl, llmModel };
    try {
      await chat.connect(project.trim(), false, modelMode === "custom" ? {
        llm: {
          baseUrl: llmBaseUrl.trim().replace(/\/+$/, ""),
          ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {}),
          model: llmModel.trim(),
        },
      } : model, sessionMode === "history" ? selectedHistory?.id : undefined);
      if (!alive.current) return false;
      const latest = loadConfigurationHistory();
      const history = latest.length ? latest : savedConfigurations;
      const updated = rememberConfiguration(history, usedConfiguration);
      if (updated === history) setConfigStorageError("配置中的地址含凭据或不适合保存，本次未记录到浏览器历史。");
      else {
        setSavedConfigurations(updated);
        setConfigStorageError(saveConfigurationHistory(updated) ? "" : "本地存储不可用，无法保存配置；本次会话仍可正常使用。");
      }
      show("success", sessionMode === "history" ? "历史会话已恢复" : "会话已建立");
      return true;
    } catch (e) {
      show("error", (e as Error).message);
      throw e;
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-slate-50">
      <ConfigBar
        baseUrl={baseUrl}
        token={token}
        project={project}
        sessionMode={sessionMode}
        histories={histories}
        historyStatus={historyStatus}
        historyError={currentHistory?.error}
        historyId={selectedHistory?.id ?? ""}
        releasingHistoryId={releasingHistoryId}
        savedConfigurations={savedConfigurations}
        configStorageError={configStorageError}
        onRestoreConfiguration={restoreConfiguration}
        onClearConfigurations={clearConfigurations}
        model={model}
        models={models}
        modelStatus={modelStatus}
        modelError={currentDiscovery?.error}
        modelMode={modelMode}
        llmBaseUrl={llmBaseUrl}
        llmApiKey={llmApiKey}
        llmModel={llmModel}
        llmUrlInvalid={!!llmBaseUrl.trim() && !llmUrlValid}
        canConnect={canConnect}
        connecting={connecting}
        connected={!!chat.sessionId}
        modelLabel={chat.modelLabel}
        onBaseUrlChange={setBaseUrl}
        onTokenChange={setToken}
        onProjectChange={setProject}
        onSessionModeChange={changeSessionMode}
        onHistorySelect={setHistoryId}
        onHistoryRefresh={refreshHistory}
        onHistoryRelease={releaseHistory}
        onModelChange={(value) => { setModel(value); preferredModel.current = { baseUrl: config.baseUrl, model: value }; }}
        onModelModeChange={setModelMode}
        onLlmBaseUrlChange={setLlmBaseUrl}
        onLlmApiKeyChange={setLlmApiKey}
        onLlmModelChange={setLlmModel}
        onConnect={handleConnect}
        onNewSession={chat.newSession}
        knowledgeControl={<KnowledgeManager key={`memory:${skillsBindingKey}`} binding={skillsBinding} />}
        skillsControl={<SkillsManager key={skillsBindingKey} binding={skillsBinding} appliedCount={chat.skills.length} appliedRevision={chat.skillsRevision} />}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-400">
              <SparkleIcon className="h-10 w-10 text-indigo-300" />
              <p className="text-sm">通过右上角新建会话，或选择历史会话继续分析</p>
            </div>
          ) : (
            chat.messages.map((m) => <ChatMessage key={m.id} message={m} config={chat.activeConfig ?? undefined} onConfirmSkill={chat.confirmSkillPreview} />)
          )}
        </div>
      </div>

      {chat.contextStale && <div role="alert" className="border-t border-amber-200 bg-amber-50 px-4 py-3"><div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3"><div className="text-sm text-amber-900"><p className="font-medium">上下文已过期</p><p className="mt-1 text-xs">代码或已用知识已变化，请新建会话继续。输入框中的草稿会保留，历史记录仍可查看。</p></div><button type="button" disabled={connecting} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50" onClick={() => {
        if (connecting) return;
        setConnecting(true);
        void chat.restartSession().catch((failure) => show("error", failure instanceof Error ? failure.message : "无法创建新会话")).finally(() => { if (alive.current) setConnecting(false); });
      }}>新建会话继续</button></div></div>}
      <MessageInput
        disabled={!chat.sessionId || connecting}
        sendingBlocked={chat.contextStale}
        streaming={chat.streaming}
        scopeKey={chat.sessionId}
        pendingMessages={chat.pendingMessages}
        onQueue={chat.followUp}
        onSteer={chat.steer}
        onCancelPending={chat.cancelPending}
        onSend={chat.send}
        onStop={chat.stop}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
