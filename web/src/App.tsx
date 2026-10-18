import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./hooks/useChat";
import { listModels, type ModelInfo, type ServerConfig } from "./api/client";
import { ConfigBar, type ModelMode, type ModelStatus } from "./components/ConfigBar";
import { ChatMessage } from "./components/ChatMessage";
import { MessageInput } from "./components/MessageInput";
import { ToastContainer, useToast } from "./components/Toast";
import { SparkleIcon } from "./components/Icons";

interface ModelDiscovery {
  config: ServerConfig;
  models: ModelInfo[];
  status: "ready" | "empty" | "error";
  error?: string;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [project, setProject] = useState("");
  const [resume, setResume] = useState(false);
  const [model, setModel] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>("backend");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null);
  const [connecting, setConnecting] = useState(false);

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedToken = token.trim();
  const config = useMemo(
    () => ({ baseUrl: normalizedBaseUrl, token: normalizedToken }),
    [normalizedBaseUrl, normalizedToken],
  );
  const chat = useChat(config);
  const { toasts, show } = useToast();
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
  const canConnect = !!project.trim() && !!config.baseUrl && !!config.token && selectionReady && !connecting;

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
          setModel(ids.includes(r.default) ? r.default : ids[0] ?? "");
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
    try {
      await chat.connect(project.trim(), resume, modelMode === "custom" ? {
        llm: {
          baseUrl: llmBaseUrl.trim().replace(/\/+$/, ""),
          ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {}),
          model: llmModel.trim(),
        },
      } : model);
      show("success", "会话已建立");
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
        resume={resume}
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
        onResumeChange={setResume}
        onModelChange={setModel}
        onModelModeChange={setModelMode}
        onLlmBaseUrlChange={setLlmBaseUrl}
        onLlmApiKeyChange={setLlmApiKey}
        onLlmModelChange={setLlmModel}
        onConnect={handleConnect}
        onNewSession={chat.newSession}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-400">
              <SparkleIcon className="h-10 w-10 text-indigo-300" />
              <p className="text-sm">点击右上角「会话配置」开始分析</p>
            </div>
          ) : (
            chat.messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
        </div>
      </div>

      <MessageInput
        disabled={!chat.sessionId}
        streaming={chat.streaming}
        onSend={chat.send}
        onStop={chat.stop}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
