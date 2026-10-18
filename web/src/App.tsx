import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./hooks/useChat";
import { listModels, type ModelInfo } from "./api/client";
import { ConfigBar } from "./components/ConfigBar";
import { ChatMessage } from "./components/ChatMessage";
import { MessageInput } from "./components/MessageInput";
import { ToastContainer, useToast } from "./components/Toast";
import { SparkleIcon } from "./components/Icons";

const FALLBACK_MODELS: ModelInfo[] = [
  { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
];
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

export default function App() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [project, setProject] = useState("");
  const [resume, setResume] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS);
  const [connecting, setConnecting] = useState(false);

  const config = useMemo(() => ({ baseUrl: baseUrl.replace(/\/+$/, ""), token }), [baseUrl, token]);
  const chat = useChat(config);
  const { toasts, show } = useToast();

  // 填好 token 后自动拉取可用模型（带防抖，失败兜底硬编码 deepseek）
  useEffect(() => {
    let cancelled = false;
    if (!config.token) {
      setModels(FALLBACK_MODELS);
      setModel(DEFAULT_MODEL);
      return;
    }
    const timer = window.setTimeout(() => {
      listModels(config)
        .then((r) => {
          if (cancelled) return;
          setModels(r.models.length ? r.models : FALLBACK_MODELS);
          setModel(r.default || DEFAULT_MODEL);
        })
        .catch(() => {
          if (cancelled) return;
          setModels(FALLBACK_MODELS);
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
    if (!project.trim()) return;
    setConnecting(true);
    try {
      await chat.connect(project.trim(), resume, model);
      show("success", "会话已建立");
    } catch (e) {
      show("error", (e as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <ConfigBar
        baseUrl={baseUrl}
        token={token}
        project={project}
        resume={resume}
        model={model}
        models={models}
        connecting={connecting}
        connected={!!chat.sessionId}
        modelLabel={chat.modelLabel}
        onBaseUrlChange={setBaseUrl}
        onTokenChange={setToken}
        onProjectChange={setProject}
        onResumeChange={setResume}
        onModelChange={setModel}
        onConnect={handleConnect}
        onNewSession={chat.newSession}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-400">
              <SparkleIcon className="h-10 w-10 text-indigo-300" />
              <p className="text-sm">建会话后即可开始提问</p>
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
