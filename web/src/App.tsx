import { useMemo, useState } from "react";
import { Empty, message } from "antd";
import { useChat } from "./hooks/useChat";
import { ConfigBar } from "./components/ConfigBar";
import { ChatMessage } from "./components/ChatMessage";
import { MessageInput } from "./components/MessageInput";

export default function App() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [project, setProject] = useState("");
  const [connecting, setConnecting] = useState(false);

  const config = useMemo(
    () => ({ baseUrl: baseUrl.replace(/\/+$/, ""), token }),
    [baseUrl, token],
  );
  const chat = useChat(config);

  const handleConnect = async () => {
    if (!project.trim()) return;
    setConnecting(true);
    try {
      await chat.connect(project.trim());
      message.success("会话已建立");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <ConfigBar
        baseUrl={baseUrl}
        token={token}
        project={project}
        connecting={connecting}
        sessionId={chat.sessionId}
        modelLabel={chat.modelLabel}
        onBaseUrlChange={setBaseUrl}
        onTokenChange={setToken}
        onProjectChange={setProject}
        onConnect={handleConnect}
        onNewSession={chat.newSession}
      />

      <div className="flex-1 overflow-y-auto">
        {chat.messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty description="建会话后即可开始提问" />
          </div>
        ) : (
          chat.messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}
      </div>

      <MessageInput
        disabled={!chat.sessionId}
        streaming={chat.streaming}
        onSend={chat.send}
        onStop={chat.stop}
      />
    </div>
  );
}
