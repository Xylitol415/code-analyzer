import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage, SseEventName, ToolCall } from "../types";
import { askStream, createSession, type ServerConfig } from "../api/client";

const GREETING_PROMPT =
  "会话已建立。请用简短友好的中文向用户打个招呼，介绍你是只读的代码逻辑分析助手，能帮他分析项目整体架构、追踪调用链、解释某段代码逻辑、查看代码演进历史等，并邀请他开始提问。不要冗长。";
const SUMMARY_PROMPT =
  "欢迎回来。请用简短的中文总结我们之前讨论过的内容和主要结论，方便用户快速回顾，然后邀请他继续提问。";

export interface UseChatApi {
  messages: ChatMessage[];
  sessionId: string | null;
  modelLabel: string | null;
  streaming: boolean;
  connect: (project: string, resume: boolean, modelId?: string) => Promise<void>;
  send: (question: string) => Promise<void>;
  stop: () => void;
  newSession: () => void;
}

interface Buffer {
  text: string;
  thinking: string;
  tools: ToolCall[];
  error?: string;
}

export function useChat(config: ServerConfig): UseChatApi {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const bufferRef = useRef<Buffer>({ text: "", thinking: "", tools: [] });
  const flushTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const flushBuffer = useCallback((finalize: boolean) => {
    const id = activeIdRef.current;
    if (!id) return;
    const buf = bufferRef.current;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              content: buf.text,
              thinking: buf.thinking,
              tools: [...buf.tools],
              error: buf.error,
              streaming: finalize ? false : m.streaming,
            }
          : m,
      ),
    );
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushBuffer(false);
    }, 60);
  }, [flushBuffer]);

  /** 发起一次流式提问；showUser=false 表示开场（不显示为用户气泡）。 */
  const runAsk = useCallback(
    async (sid: string, question: string, opts: { showUser: boolean }) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      const asstId = crypto.randomUUID();
      const asstMsg: ChatMessage = {
        id: asstId,
        role: "assistant",
        content: "",
        thinking: "",
        tools: [],
        streaming: true,
      };

      activeIdRef.current = asstId;
      bufferRef.current = { text: "", thinking: "", tools: [] };

      if (opts.showUser) {
        const userMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: trimmed,
          thinking: "",
          tools: [],
          streaming: false,
        };
        setMessages((prev) => [...prev, userMsg, asstMsg]);
      } else {
        setMessages((prev) => [...prev, asstMsg]);
      }
      setStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const handleEvent = (event: SseEventName, data: unknown) => {
        const buf = bufferRef.current;
        switch (event) {
          case "thinking": {
            const d = data as { delta?: string };
            if (d?.delta) buf.thinking += d.delta;
            scheduleFlush();
            break;
          }
          case "text": {
            const d = data as { delta?: string };
            if (d?.delta) buf.text += d.delta;
            scheduleFlush();
            break;
          }
          case "tool": {
            const d = data as { name: string; args?: unknown; phase: "start" | "end"; isError?: boolean };
            if (d.phase === "start") {
              buf.tools.push({ name: d.name, args: d.args });
            } else {
              for (let i = buf.tools.length - 1; i >= 0; i--) {
                if (buf.tools[i].name === d.name && buf.tools[i].isError === undefined) {
                  buf.tools[i] = { ...buf.tools[i], isError: d.isError ?? false };
                  break;
                }
              }
            }
            scheduleFlush();
            break;
          }
          case "done": {
            const d = data as { answer?: string };
            if (typeof d.answer === "string") buf.text = d.answer;
            scheduleFlush();
            break;
          }
          case "error": {
            const d = data as { message?: string };
            buf.error = d?.message ?? "未知错误";
            scheduleFlush();
            break;
          }
        }
      };

      try {
        await askStream(config, sid, trimmed, ctrl.signal, handleEvent);
      } catch (e) {
        const err = e as Error;
        if (err.name !== "AbortError") bufferRef.current.error = err.message;
      } finally {
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushBuffer(true);
        setStreaming(false);
        activeIdRef.current = null;
      }
    },
    [config, flushBuffer, scheduleFlush],
  );

  const connect = useCallback(
    async (project: string, resume: boolean, modelId?: string) => {
      const s = await createSession(config, project, resume, modelId);
      sessionIdRef.current = s.id;
      setSessionId(s.id);
      setModelLabel(s.modelLabel);
      setMessages([]);
      // 自动触发开场（不阻塞 connect 返回）：恢复→总结，新建→打招呼
      void runAsk(s.id, s.resumed ? SUMMARY_PROMPT : GREETING_PROMPT, { showUser: false });
    },
    [config, runAsk],
  );

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    sessionIdRef.current = null;
    setSessionId(null);
    setModelLabel(null);
    setMessages([]);
    setStreaming(false);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    (question: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return Promise.resolve();
      return runAsk(sid, question, { showUser: true });
    },
    [runAsk],
  );

  return useMemo(
    () => ({ messages, sessionId, modelLabel, streaming, connect, send, stop, newSession }),
    [messages, sessionId, modelLabel, streaming, connect, send, stop, newSession],
  );
}
