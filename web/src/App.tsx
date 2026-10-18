import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./hooks/useChat";
import { ConfigBar } from "./components/ConfigBar";
import { ChatMessage } from "./components/ChatMessage";
import { MessageInput } from "./components/MessageInput";
import { ToastContainer, useToast } from "./components/Toast";
import { SparkleIcon } from "./components/Icons";

export default function App() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [project, setProject] = useState("");
  const [resume, setResume] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const config = useMemo(() => ({ baseUrl: baseUrl.replace(/\/+$/, ""), token }), [baseUrl, token]);
  const chat = useChat(config);
  const { toasts, show } = useToast();

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.messages]);

  const handleConnect = async () => {
    if (!project.trim()) return;
    setConnecting(true);
    try {
      await chat.connect(project.trim(), resume);
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
        connecting={connecting}
        connected={!!chat.sessionId}
        modelLabel={chat.modelLabel}
        onBaseUrlChange={setBaseUrl}
        onTokenChange={setToken}
        onProjectChange={setProject}
        onResumeChange={setResume}
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
