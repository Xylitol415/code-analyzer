import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, SseEventName, ToolCall, SkillPreview, SkillSnapshot, AnswerMetadata } from "../types";
import { askStream, createSession, deleteSession, confirmSkillImport, type ServerConfig, type SessionModel } from "../api/client";

const WELCOME = "你好，我是只读代码分析助手。可以帮助你分析项目架构、追踪调用链、解释代码逻辑和查看代码演进历史。请输入你的问题。";

export interface UseChatApi {
  messages: ChatMessage[];
  sessionId: string | null;
  modelLabel: string | null;
  streaming: boolean;
  projectPath: string | null;
  activeConfig: ServerConfig | null;
  skills: SkillSnapshot["skills"];
  skillsRevision: number;
  confirmSkillPreview: (preview: SkillPreview) => Promise<void>;
  connect: (project: string, resume: boolean, model?: SessionModel, historyId?: string) => Promise<void>;
  send: (question: string, reuse?: "auto" | "bypass") => Promise<void>;
  contextStale: boolean;
  restartSession: () => Promise<void>;
  stop: () => void;
  newSession: () => void;
  disconnect: (sessionId: string, config: ServerConfig) => Promise<void>;
}

interface Buffer {
  text: string;
  thinking: string;
  tools: ToolCall[];
  error?: string;
  stopped?: boolean;
  metadata?: Partial<AnswerMetadata>;
}

interface ActiveSession {
  id: string;
  config: ServerConfig;
  projectPath: string;
  model?: SessionModel;
  stale?: boolean;
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
  const [contextStale, setContextStale] = useState(false);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<ServerConfig | null>(null);
  const [skills, setSkills] = useState<SkillSnapshot["skills"]>([]);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const previewOrigins = useRef(new Map<string, ActiveSession>());


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
              ...buf.metadata,
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

  const resetSession = useCallback((updateState = true, releaseRemote = true) => {
    connectionVersionRef.current += 1;
    stopStream(updateState);
    const previous = sessionRef.current;
    sessionRef.current = null;
    previewOrigins.current.clear();
    if (previous && releaseRemote) releaseSession(previous);
    if (updateState) {
      setContextStale(false);
      setSessionId(null);
      setProjectPath(null);
      setActiveConfig(null);
      setSkills([]);
      setSkillsRevision(0);
      setModelLabel(null);
      setMessages([]);
      setStreaming(false);
    }
  }, [stopStream]);

  useEffect(() => {
    // Refresh/navigation does not reliably unmount React. keepalive in
    // deleteSession allows this authenticated request to outlive the page.
    const pagehide = () => resetSession(false);
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) resetSession();
    };
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    return () => {
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pageshow);
      resetSession(false);
    };
  }, [resetSession]);

  const disconnect = useCallback(async (id: string, serverConfig: ServerConfig) => {
    await deleteSession(serverConfig, id);
    const current = sessionRef.current;
    // A delayed release of another window must not reset a newer connection.
    if (current?.id === id && current.config.baseUrl === serverConfig.baseUrl && current.config.token === serverConfig.token) {
      resetSession(true, false);
    }
  }, [resetSession]);

  /** 发起一次用户提问；请求标识在整个流式请求期间保持稳定。 */
  const runAsk = useCallback(
    async (session: ActiveSession, question: string, opts: { showUser: boolean; reuse?: "auto" | "bypass" }) => {
      const trimmed = question.trim();
      if (!trimmed || session.stale || streamRef.current || sessionRef.current !== session) return;

      const requestId = crypto.randomUUID();
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
          case "skill_preview": {
            const preview = data as SkillPreview;
            if (preview.projectPath !== session.projectPath) break;
            previewOrigins.current.set(preview.id, session);
            setMessages((prev) => prev.map((message) => message.id === stream.id
              ? { ...message, skillPreviews: [...(message.skillPreviews ?? []).filter((item) => item.id !== preview.id), preview] }
              : message));
            break;
          }
          case "skills_applied": {
            const snapshot = data as SkillSnapshot;
            if (snapshot.projectPath !== session.projectPath) break;
            setSkills(snapshot.skills);
            setSkillsRevision(snapshot.revision);
            break;
          }
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
            const d = data as Partial<AnswerMetadata> & { answer?: string };
            buf.metadata = { answerId: d.answerId, answerVersion: d.answerVersion, source: d.source, knowledgeIds: d.knowledgeIds, usage: d.usage };
            if (typeof d.answer === "string") buf.text = d.answer;
            scheduleFlush(stream);
            break;
          }
          case "error": {
            const d = data as { message?: string; code?: string };
            if (d.code === "context_stale") { session.stale = true; setContextStale(true); }
            buf.error = d?.message ?? "未知错误";
            scheduleFlush(stream);
            break;
          }
        }
      };

      try {
        await askStream(session.config, session.id, trimmed, stream.controller.signal, handleEvent, { requestId, reuse: opts.reuse ?? "auto" });
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
    async (project: string, resume: boolean, model?: SessionModel, historyId?: string, originConfig = config) => {
      resetSession();
      const version = connectionVersionRef.current;
      const sessionConfig = { ...originConfig };
      const s = await createSession(sessionConfig, project, resume, model, historyId);
      const session: ActiveSession = { id: s.id, config: sessionConfig, projectPath: s.projectPath, model, stale: s.messages?.some((message) => message.stale) };
      // A reset, newer connect, or unmount may have happened while POST was pending.
      if (connectionVersionRef.current !== version) {
        releaseSession(session);
        return;
      }
      sessionRef.current = session;
      setSessionId(s.id);
      setModelLabel(s.modelLabel);
      setProjectPath(s.projectPath);
      setActiveConfig(sessionConfig);
      setSkills(s.skills ?? []);
      setSkillsRevision(s.skillsRevision ?? 0);
      setContextStale(!!session.stale);
      setMessages(s.messages ?? (!s.resumed && !historyId ? [{ id: crypto.randomUUID(), role: "assistant", content: WELCOME, thinking: "", tools: [], streaming: false }] : []));
    },
    [config, resetSession],
  );

  const restartSession = useCallback(async () => {
    const current = sessionRef.current;
    if (current) await connect(current.projectPath, false, current.model, undefined, current.config);
  }, [connect]);

  const newSession = useCallback(() => {
    resetSession();
  }, [resetSession]);

  const stop = useCallback(() => {
    stopStream(true, true);
  }, [stopStream]);

  const send = useCallback(
    (question: string, reuse: "auto" | "bypass" = "auto") => {
      const session = sessionRef.current;
      if (!session) return Promise.resolve();
      return runAsk(session, question, { showUser: true, reuse });
    },
    [runAsk],
  );

  const confirmSkillPreview = useCallback(async (preview: SkillPreview) => {
    const session = previewOrigins.current.get(preview.id);
    if (!session || sessionRef.current !== session || preview.projectPath !== session.projectPath) {
      throw new Error("该预览不属于当前会话，请在 Skills 中重新预览。");
    }
    const confirmation = await confirmSkillImport(session.config, preview.id);
    if (sessionRef.current !== session) return;
    if (confirmation.snapshot.projectPath !== session.projectPath) throw new Error("导入结果的项目不匹配。");
    setMessages((prev) => prev.map((message) => message.skillPreviews?.some((item) => item.id === preview.id)
      ? { ...message, confirmedSkillPreviews: [...new Set([...(message.confirmedSkillPreviews ?? []), preview.id])] }
      : message));
  }, []);

  return useMemo(
    () => ({ messages, sessionId, modelLabel, streaming, contextStale, restartSession, projectPath, activeConfig, skills, skillsRevision, confirmSkillPreview, connect, send, stop, newSession, disconnect }),
    [messages, sessionId, modelLabel, streaming, contextStale, restartSession, projectPath, activeConfig, skills, skillsRevision, confirmSkillPreview, connect, send, stop, newSession, disconnect],
  );
}
