import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, SseEventName, ToolCall, SkillPreview, SkillSnapshot, AnswerMetadata, PendingSessionMessage, SessionMessageState, SteeringApplied } from "../types";
import { askStream, getSessionMessages, steerSession, cancelSessionMessage, createSession, deleteSession, confirmSkillImport, type ServerConfig, type SessionModel } from "../api/client";

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
  pendingMessages: PendingSessionMessage[];
  activeRequestId: string | null;
  followUp: (question: string, reuse?: "auto" | "bypass") => Promise<void>;
  steer: (question: string) => Promise<void>;
  cancelPending: (messageId: string) => Promise<PendingSessionMessage>;
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
  requestId: string;
  started: boolean;
  accept: () => void;
  reject: (error: Error) => void;
  controller: AbortController;
  buffer: Buffer;
  flushTimer: number | null;
}

interface RequestOrder {
  submission: number;
  revision?: number;
}

// Failed/unadmitted requests retain their submission slots. Only server-known
// groups exchange slots according to authoritative execution revisions.
function orderRequestMessages(messages: ChatMessage[], owners: Map<string, string>, orders: Map<string, RequestOrder>): ChatMessage[] {
  const history: ChatMessage[] = [];
  const groups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const requestId = owners.get(message.id);
    if (!requestId) { history.push(message); continue; }
    const group = groups.get(requestId) ?? [];
    group.push(message);
    groups.set(requestId, group);
  }
  const submitted = [...groups].sort(([a], [b]) => (orders.get(a)?.submission ?? 0) - (orders.get(b)?.submission ?? 0));
  const executed = submitted.filter(([id]) => orders.get(id)?.revision !== undefined)
    .sort(([a], [b]) => orders.get(a)!.revision! - orders.get(b)!.revision!);
  let nextExecuted = 0;
  return [...history, ...submitted.flatMap(([id, group]) => orders.get(id)?.revision === undefined ? group : executed[nextExecuted++][1])];
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
  const [pendingMessages, setPendingMessages] = useState<PendingSessionMessage[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const messageStateRef = useRef<SessionMessageState>({ revision: -1, activeRequestId: null, pending: [] });
  const streamsRef = useRef(new Map<string, ActiveStream>());
  const messageOwnersRef = useRef(new Map<string, string>());
  const requestOrdersRef = useRef(new Map<string, RequestOrder>());
  const submissionOrderRef = useRef(0);
  const latestServerStartRef = useRef(-1);
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
    if (streamsRef.current.get(stream.requestId) !== stream) return;
    const id = stream.id;
    const buf = stream.buffer;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
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
      flushBuffer(stream, streamRef.current !== stream);
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
    streamsRef.current.delete(stream.requestId);
    stream.controller.abort();
    stream.accept();
    if (updateState) { setStreaming(false); setActiveRequestId(null); }
  }, [flushBuffer]);

  const resetSession = useCallback((updateState = true, releaseRemote = true) => {
    connectionVersionRef.current += 1;
    stopStream(updateState);
    for (const stream of streamsRef.current.values()) {
      if (stream.flushTimer !== null) window.clearTimeout(stream.flushTimer);
      stream.controller.abort();
      stream.accept();
    }
    streamsRef.current.clear();
    messageOwnersRef.current.clear();
    requestOrdersRef.current.clear();
    submissionOrderRef.current = 0;
    latestServerStartRef.current = -1;
    messageStateRef.current = { revision: -1, activeRequestId: null, pending: [] };
    const previous = sessionRef.current;
    sessionRef.current = null;
    previewOrigins.current.clear();
    if (previous && releaseRemote) releaseSession(previous);
    if (updateState) {
      setPendingMessages([]);
      setActiveRequestId(null);
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

  const applyMessageState = useCallback((session: ActiveSession, state: SessionMessageState) => {
    if (sessionRef.current !== session || state.revision <= messageStateRef.current.revision || state.revision < latestServerStartRef.current) return;
    messageStateRef.current = state;
    setPendingMessages(state.pending);
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    // Stopping the only SSE connection loses its final queue update. Reconcile
    // until pending steering is marked unapplied or a queued task starts.
    if (!session || streaming || !pendingMessages.some(message => message.status === "pending")) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      if (controller.signal.aborted || sessionRef.current !== session || streamRef.current) return;
      try {
        const state = await getSessionMessages(session.config, session.id, controller.signal);
        if (!controller.signal.aborted) applyMessageState(session, state);
      } catch { /* Retain cards and retry; cancellation still surfaces its own error. */ }
      if (!controller.signal.aborted && sessionRef.current === session) timer = window.setTimeout(poll, 1000);
    };
    timer = window.setTimeout(poll, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId, streaming, pendingMessages, applyMessageState]);

  const runAsk = useCallback(
    (session: ActiveSession, question: string, opts: { reuse?: "auto" | "bypass"; followUp?: boolean }) => {
      const trimmed = question.trim();
      if (!trimmed || session.stale || sessionRef.current !== session) return Promise.resolve();
      const requestId = crypto.randomUUID();
      let admitted = false;
      let accept!: () => void;
      let reject!: (error: Error) => void;
      const accepted = new Promise<void>((resolve, fail) => { accept = () => { admitted = true; resolve(); }; reject = fail; });
      // Normal callers await the complete lifecycle; only queued submissions use acceptance.
      if (!opts.followUp) void accepted.catch(() => {});
      const stream: ActiveStream = {
        id: crypto.randomUUID(), requestId, started: false, accept, reject,
        controller: new AbortController(), buffer: { text: "", thinking: "", tools: [] }, flushTimer: null,
      };
      requestOrdersRef.current.set(requestId, { submission: ++submissionOrderRef.current });
      streamsRef.current.set(requestId, stream);
      const appendSegment = (userQuestion?: string) => {
        const assistant: ChatMessage = { id: stream.id, role: "assistant", content: "", thinking: "", tools: [], streaming: streamRef.current === stream };
        const user: ChatMessage | undefined = userQuestion === undefined ? undefined : {
          id: crypto.randomUUID(), role: "user", content: userQuestion, thinking: "", tools: [], streaming: false,
        };
        const added = [...(user ? [user] : []), assistant];
        for (const message of added) messageOwnersRef.current.set(message.id, requestId);
        setMessages(previous => orderRequestMessages([...previous, ...added], messageOwnersRef.current, requestOrdersRef.current));
      };
      const start = (startedQuestion: string, revision?: number) => {
        // Submission counters never participate in server ownership comparisons:
        // offline failures can advance locally without advancing server revision.
        if (stream.started && revision === undefined) return;
        const ownsActive = revision === undefined || revision >= latestServerStartRef.current;
        if (revision !== undefined) {
          requestOrdersRef.current.get(requestId)!.revision = revision;
          latestServerStartRef.current = Math.max(latestServerStartRef.current, revision);
        }
        if (ownsActive) {
          const previous = streamRef.current;
          if (previous && previous !== stream) {
            if (previous.flushTimer !== null) { window.clearTimeout(previous.flushTimer); previous.flushTimer = null; }
            flushBuffer(previous, true);
          }
          streamRef.current = stream;
          setStreaming(true);
          setActiveRequestId(requestId);
        }
        setPendingMessages(previous => previous.filter(message => message.id !== requestId));
        if (!stream.started) {
          stream.started = true;
          appendSegment(startedQuestion);
        } else {
          setMessages(previous => orderRequestMessages(previous.map(message => message.id === stream.id
            ? {...message, streaming: ownsActive} : message), messageOwnersRef.current, requestOrdersRef.current));
        }
        accept();
      };
      // Preserve immediate display and full lifecycle semantics for ordinary asks.
      if (!opts.followUp) start(trimmed);
      const handleEvent = (event: SseEventName, data: unknown) => {
        if (sessionRef.current !== session || streamsRef.current.get(requestId) !== stream) return;
        if (event === "queue") {
          const state = data as SessionMessageState;
          applyMessageState(session, state);
          // The initial subscription snapshot precedes registration. It does not
          // confirm this submission until its own identity appears.
          if (state.activeRequestId === requestId || state.pending.some(message => message.id === requestId)) accept();
          return;
        }
        if (event === "started") {
          const started = data as {requestId: string; question: string; revision?: number};
          if (started.requestId === requestId) start(started.question, started.revision);
          return;
        }
        if (event === "cancelled") {
          if ((data as {requestId: string}).requestId !== requestId) return;
          setPendingMessages(previous => previous.filter(message => message.id !== requestId));
          streamsRef.current.delete(requestId);
          accept();
          return;
        }
        if (!stream.started) {
          if (event === "error") reject(new Error((data as {message?: string}).message ?? "无法加入队列"));
          return;
        }
        // Each independent SSE connection owns its output and steering segments;
        // only start ordering grants ownership of composer/stop/steer controls.
        if (event === "steering_applied") {
          const correction = data as SteeringApplied;
          if (correction.targetRequestId !== requestId) return;
          if (stream.flushTimer !== null) { window.clearTimeout(stream.flushTimer); stream.flushTimer = null; }
          flushBuffer(stream, true);
          stream.id = crypto.randomUUID();
          stream.buffer = { text: "", thinking: "", tools: [] };
          setPendingMessages(previous => previous.filter(message => message.id !== correction.requestId));
          appendSegment(correction.question);
          return;
        }
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
            if (streamRef.current !== stream) break;
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
            if (streamRef.current === stream) scheduleFlush(stream);
            else flushBuffer(stream, true);
            break;
          }
          case "error": {
            const d = data as { message?: string; code?: string };
            if (d.code === "context_stale") { session.stale = true; setContextStale(true); }
            buf.error = d?.message ?? "未知错误";
            if (streamRef.current === stream) scheduleFlush(stream);
            else flushBuffer(stream, true);
            break;
          }
        }
      };
      const completed = (async () => {
        try {
          await askStream(session.config, session.id, trimmed, stream.controller.signal, handleEvent,
            { requestId, reuse: opts.reuse ?? "auto", ...(opts.followUp ? {mode: "followUp" as const} : {}) });
          if (!admitted) reject(new Error("消息流提前结束，请重试。"));
        } catch (failure) {
          const error = failure as Error;
          if (error.name !== "AbortError") { stream.buffer.error = error.message; reject(error); }
          else accept();
        } finally {
          if (streamsRef.current.get(requestId) === stream) {
            if (stream.flushTimer !== null) window.clearTimeout(stream.flushTimer);
            if (sessionRef.current === session && stream.started) flushBuffer(stream, true);
            streamsRef.current.delete(requestId);
            if (streamRef.current === stream) {
              streamRef.current = null;
              setStreaming(false);
              setActiveRequestId(null);
            }
          }
        }
      })();
      return opts.followUp ? accepted : completed;
    }, [applyMessageState, flushBuffer, scheduleFlush],
  );

  const steer = useCallback(async (question: string) => {
    const session = sessionRef.current;
    const targetRequestId = streamRef.current?.requestId;
    if (!session || session.stale || !targetRequestId) throw new Error("当前任务已结束，请发送新的问题。");
    const result = await steerSession(session.config, session.id, { question: question.trim(), requestId: crypto.randomUUID(), targetRequestId });
    if (sessionRef.current !== session) throw new Error("会话已切换，消息未回填。");
    applyMessageState(session, result.state);
  }, [applyMessageState]);

  const cancelPending = useCallback(async (messageId: string) => {
    const session = sessionRef.current;
    if (!session) throw new Error("会话已结束。");
    const result = await cancelSessionMessage(session.config, session.id, messageId);
    if (sessionRef.current !== session) throw new Error("会话已切换，消息未回填。");
    applyMessageState(session, result.state);
    return result.message;
  }, [applyMessageState]);

  const followUp = useCallback((question: string, reuse: "auto" | "bypass" = "auto") => {
    const session = sessionRef.current;
    if (!session) return Promise.reject(new Error("请先建立会话。"));
    return runAsk(session, question, { reuse, followUp: true });
  }, [runAsk]);

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
      // A stopped active request can leave accepted follow-ups waiting for
      // their started events. New submissions must stay behind those streams.
      return runAsk(session, question, { reuse, followUp: streamsRef.current.size > 0 });
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
    () => ({ messages, pendingMessages, activeRequestId, followUp, steer, cancelPending, sessionId, modelLabel, streaming, contextStale, restartSession, projectPath, activeConfig, skills, skillsRevision, confirmSkillPreview, connect, send, stop, newSession, disconnect }),
    [messages, pendingMessages, activeRequestId, followUp, steer, cancelPending, sessionId, modelLabel, streaming, contextStale, restartSession, projectPath, activeConfig, skills, skillsRevision, confirmSkillPreview, connect, send, stop, newSession, disconnect],
  );
}
