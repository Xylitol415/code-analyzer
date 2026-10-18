import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, SseEventName, ToolCall } from "../types";
import { askStream, createSession, deleteSession, type ServerConfig, type SessionModel } from "../api/client";

const GREETING_PROMPT =
  "会话已建立。请用简短友好的中文向用户打个招呼，介绍你是只读的代码逻辑分析助手，能帮他分析项目整体架构、追踪调用链、解释某段代码逻辑、查看代码演进历史等，并邀请他开始提问。不要冗长。";

export interface UseChatApi {
  messages: ChatMessage[];
  sessionId: string | null;
  modelLabel: string | null;
  streaming: boolean;
  connect: (project: string, resume: boolean, model?: SessionModel, historyId?: string) => Promise<void>;
  send: (question: string) => Promise<void>;
  stop: () => void;
  newSession: () => void;
}

interface Buffer {
  text: string;
  thinking: string;
  tools: ToolCall[];
  error?: string;
  stopped?: boolean;
}

interface ActiveSession {
  id: string;
  config: ServerConfig;
}

interface ActiveStream {
  id: string;
  controller: AbortController;
  buffer: Buffer;
  flushTimer: number | null;
}

function releaseSession(session: ActiveSession): void {
  void deleteSession(session.config, session.id).catch((error) => {
    console.warn(`无法清理服务端会话 ${session.id}`, error);
  });
}

export function useChat(config: ServerConfig): UseChatApi {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const streamRef = useRef<ActiveStream | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const connectionVersionRef = useRef(0);

  const flushBuffer = useCallback((stream: ActiveStream, finalize: boolean) => {
    if (streamRef.current !== stream) return;
    const buf = stream.buffer;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === stream.id
          ? {
              ...m,
              content: buf.text,
              thinking: buf.thinking,
              tools: [...buf.tools],
              error: buf.error,
              stopped: buf.stopped,
              streaming: finalize ? false : m.streaming,
            }
          : m,
      ),
    );
  }, []);

  const scheduleFlush = useCallback((stream: ActiveStream) => {
    if (stream.flushTimer !== null) return;
    stream.flushTimer = window.setTimeout(() => {
      stream.flushTimer = null;
      flushBuffer(stream, false);
    }, 60);
  }, [flushBuffer]);

  const stopStream = useCallback((updateState = true, stopped = false) => {
    const stream = streamRef.current;
    if (!stream) return;
    if (stream.flushTimer !== null) window.clearTimeout(stream.flushTimer);
    if (stopped) stream.buffer.stopped = true;
    if (updateState) flushBuffer(stream, true);
    // Revoke ownership before abort resolves the old request's promise.
    streamRef.current = null;
    stream.controller.abort();
    if (updateState) setStreaming(false);
  }, [flushBuffer]);

  const resetSession = useCallback((updateState = true) => {
    connectionVersionRef.current += 1;
    stopStream(updateState);
    const previous = sessionRef.current;
    sessionRef.current = null;
    if (previous) releaseSession(previous);
    if (updateState) {
      setSessionId(null);
      setModelLabel(null);
      setMessages([]);
      setStreaming(false);
    }
  }, [stopStream]);

  useEffect(() => () => resetSession(false), [resetSession]);

  /** 发起一次流式提问；showUser=false 表示开场（不显示为用户气泡）。 */
  const runAsk = useCallback(
    async (session: ActiveSession, question: string, opts: { showUser: boolean }) => {
      const trimmed = question.trim();
      if (!trimmed || streamRef.current || sessionRef.current !== session) return;

      const asstId = crypto.randomUUID();
      const asstMsg: ChatMessage = {
        id: asstId,
        role: "assistant",
        content: "",
        thinking: "",
        tools: [],
        streaming: true,
      };

      const stream: ActiveStream = {
        id: asstId,
        controller: new AbortController(),
        buffer: { text: "", thinking: "", tools: [] },
        flushTimer: null,
      };
      streamRef.current = stream;

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

      const handleEvent = (event: SseEventName, data: unknown) => {
        if (streamRef.current !== stream) return;
        const buf = stream.buffer;
        switch (event) {
          case "thinking": {
            const d = data as { delta?: string };
            if (d?.delta) buf.thinking += d.delta;
            scheduleFlush(stream);
            break;
          }
          case "text": {
            const d = data as { delta?: string };
            if (d?.delta) buf.text += d.delta;
            scheduleFlush(stream);
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
            scheduleFlush(stream);
            break;
          }
          case "done": {
            const d = data as { answer?: string };
            if (typeof d.answer === "string") buf.text = d.answer;
            scheduleFlush(stream);
            break;
          }
          case "error": {
            const d = data as { message?: string };
            buf.error = d?.message ?? "未知错误";
            scheduleFlush(stream);
            break;
          }
        }
      };

      try {
        await askStream(session.config, session.id, trimmed, stream.controller.signal, handleEvent);
      } catch (e) {
        const err = e as Error;
        if (err.name !== "AbortError") stream.buffer.error = err.message;
      } finally {
        if (streamRef.current === stream) {
          if (stream.flushTimer !== null) window.clearTimeout(stream.flushTimer);
          flushBuffer(stream, true);
          streamRef.current = null;
          setStreaming(false);
        }
      }
    },
    [flushBuffer, scheduleFlush],
  );

  const connect = useCallback(
    async (project: string, resume: boolean, model?: SessionModel, historyId?: string) => {
      resetSession();
      const version = connectionVersionRef.current;
      const sessionConfig = { ...config };
      const s = await createSession(sessionConfig, project, resume, model, historyId);
      const session = { id: s.id, config: sessionConfig };
      // A reset, newer connect, or unmount may have happened while POST was pending.
      if (connectionVersionRef.current !== version) {
        releaseSession(session);
        return;
      }
      sessionRef.current = session;
      setSessionId(s.id);
      setModelLabel(s.modelLabel);
      setMessages(s.messages ?? []);
      // Restoring only loads the transcript; it must not append a new model turn.
      if (!s.resumed && !historyId) {
        void runAsk(session, GREETING_PROMPT, { showUser: false });
      }
    },
    [config, resetSession, runAsk],
  );

  const newSession = useCallback(() => {
    resetSession();
  }, [resetSession]);

  const stop = useCallback(() => {
    stopStream(true, true);
  }, [stopStream]);

  const send = useCallback(
    (question: string) => {
      const session = sessionRef.current;
      if (!session) return Promise.resolve();
      return runAsk(session, question, { showUser: true });
    },
    [runAsk],
  );

  return useMemo(
    () => ({ messages, sessionId, modelLabel, streaming, connect, send, stop, newSession }),
    [messages, sessionId, modelLabel, streaming, connect, send, stop, newSession],
  );
}
