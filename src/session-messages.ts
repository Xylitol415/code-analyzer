import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionQueue } from "./session-queue.js";
import type { PendingSessionMessage, SessionMessageState, SteeringApplied } from "./session-message-types.js";

export class SessionMessageError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429) { super(message); }
}
export class PendingMessageCancelled extends Error {
  readonly name = "AbortError";
  constructor() { super("待处理消息已取消"); }
}
type Phase = "pending" | "running" | "applied" | "finished" | "cancelled" | "unapplied";
interface Entry {
  message: PendingSessionMessage;
  phase: Phase;
  controller?: AbortController;
  onSteeringApplied?: (message: SteeringApplied) => void;
  prompt?: string;
}
interface RunOptions {
  signal?: AbortSignal;
  onStarted?: () => void;
  onSteeringApplied?: (message: SteeringApplied) => void;
}

/** Host-owned pending messages: deletion and adoption share one synchronous boundary. */
export class SessionMessages {
  private entries = new Map<string, Entry>();
  private active?: Entry;
  private committed?: Entry;
  private revision = 0;
  private closed = false;
  private listeners = new Set<(state: SessionMessageState) => void>();

  constructor(private session: Pick<AgentSession, "agent">, private queue: SessionQueue,
    private adopted: (message: SteeringApplied) => void = () => {},
    private prepareSteering: (question: string) => string = question => question) {
    const agent = session.agent;
    const finish = agent.finishTurn;
    const prepare = agent.prepareNextTurnWithContext;
    const plainPrepare = agent.prepareNextTurn;
    agent.finishTurn = async (turn, signal) => {
      const decision = await finish?.call(agent, turn, signal);
      const entry = this.nextSteering();
      if (!signal?.aborted && decision?.action !== "end" && entry) {
        // Returning continue schedules another model turn. Reserve its input
        // now: deleting it during async compaction would leave a phantom turn.
        entry.phase = "applied";
        this.committed = entry;
        this.changed();
        return { action: "continue" };
      }
      return decision || undefined;
    };
    agent.prepareNextTurnWithContext = async (context, signal) => {
      const active = this.active;
      const update = prepare ? await prepare.call(agent, context, signal) : await plainPrepare?.call(agent, signal);
      if (signal?.aborted || this.closed || this.active !== active) return update;
      const entry = this.committed ?? this.nextSteering();
      if (!entry || !active) return update;
      const message: SteeringApplied = { requestId: entry.message.id, question: entry.message.question, targetRequestId: active.message.id };
      // No await from selection to marking adopted: DELETE either wins before
      // this point or gets 409. Never clear/rebuild SDK private queues.
      entry.phase = "applied";
      this.committed = undefined;
      this.adopted(message);
      active.onSteeringApplied?.(message);
      this.changed();
      return { ...update, messages: [...(update?.messages ?? []), { role: "user", content: entry.prompt ?? message.question, timestamp: Date.now() }] };
    };
  }

  private nextSteering(): Entry | undefined {
    if (this.closed || !this.active || this.active.controller?.signal.aborted) return;
    return [...this.entries.values()].find(entry => entry.phase === "pending" && entry.message.mode === "steer" && entry.message.targetRequestId === this.active!.message.id);
  }
  state(): SessionMessageState {
    return { revision: this.revision, activeRequestId: this.active?.message.id ?? null,
      pending: [...this.entries.values()].filter(entry => entry.phase === "pending" || entry.phase === "unapplied")
        .map(entry => ({ ...entry.message, status: entry.phase as "pending" | "unapplied" })) };
  }
  subscribe(listener: (state: SessionMessageState) => void): () => void {
    this.listeners.add(listener); listener(this.state());
    return () => { this.listeners.delete(listener); };
  }
  private changed() {
    this.revision++;
    const snapshot = this.state();
    for (const listener of this.listeners) listener(snapshot);
    // Retain terminal identities for cancellation conflicts and retry validation,
    // but do not keep an unbounded process-lifetime request log.
    if (this.entries.size > 1000) for (const [id, entry] of this.entries) {
      if (this.entries.size <= 1000) break;
      if (["finished", "cancelled", "applied"].includes(entry.phase)) this.entries.delete(id);
    }
  }
  private validate(id: string, question: string) {
    if (this.closed) throw new Error("Session is closed");
    if (typeof id !== "string" || !id.trim() || id.length > 200 || typeof question !== "string" || !question.trim()) throw new SessionMessageError("消息 ID 和内容无效", 400);
    const previous = this.entries.get(id);
    if (previous && (previous.message.question !== question || previous.phase !== "finished")) throw new SessionMessageError("消息 ID 已使用，请刷新状态或使用新的 ID", 409);
    if (this.state().pending.length >= 50) throw new SessionMessageError("待处理消息过多，请先处理或删除已有消息", 429);
  }
  steer(input: { id: string; question: string; targetRequestId: string }) {
    this.validate(input.id, input.question);
    if (!this.active || this.active.message.id !== input.targetRequestId || this.active.controller?.signal.aborted) throw new SessionMessageError("当前任务已结束或已切换，请重新发送问题", 409);
    // runAsk refreshes Skills and memory before entering the public SDK run.
    // During that preparation the loader still holds the preceding snapshot.
    if (this.session.agent.state?.isStreaming === false) throw new SessionMessageError("当前任务正在准备上下文或已进入结束阶段，请稍后重试引导，或将问题排队。", 409);
    const message: PendingSessionMessage = { ...input, mode: "steer", createdAt: Date.now(), status: "pending" };
    const prompt = this.prepareSteering(input.question);
    this.entries.set(input.id, { message, prompt, phase: "pending" }); this.changed();
    return { message, state: this.state() };
  }
  remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new SessionMessageError("消息不存在，请刷新待处理列表", 404);
    if (entry.phase === "cancelled") return { message: { ...entry.message }, state: this.state() };
    if (entry.phase !== "pending" && entry.phase !== "unapplied") throw new SessionMessageError("消息已经开始执行或已被采用，无法撤回或删除", 409);
    entry.phase = "cancelled";
    entry.controller?.abort();
    this.changed();
    return { message: { ...entry.message }, state: this.state() };
  }

  async run<T>(input: { id: string; question: string; reuse?: "auto" | "bypass" }, task: (signal: AbortSignal) => Promise<T>, options: RunOptions = {}): Promise<T> {
    this.validate(input.id, input.question);
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const entry: Entry = { message: { ...input, mode: "followUp", createdAt: Date.now(), status: "pending" }, phase: "pending", controller,
      onSteeringApplied: options.onSteeringApplied };
    let rejectCancellation!: (error: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = () => {
      if (entry.phase === "pending" || entry.phase === "cancelled") {
        entry.phase = "cancelled";
        this.changed();
        rejectCancellation(new PendingMessageCancelled());
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const externalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    this.entries.set(input.id, entry); this.changed();
    const scheduled = this.queue.run(async signal => {
      entry.phase = "running"; this.active = entry; this.changed();
      try { options.onStarted?.(); return await task(signal); }
      finally {
        entry.phase = controller.signal.aborted ? "cancelled" : "finished";
        if (this.committed?.message.targetRequestId === input.id) {
          // Preparation/compaction may fail or stop before delivery. Preserve
          // that correction for editing without sending it to the next ask.
          this.committed.phase = this.closed ? "cancelled" : "unapplied";
          this.committed = undefined;
        }
        for (const pending of this.entries.values()) if (pending.phase === "pending" && pending.message.mode === "steer" && pending.message.targetRequestId === input.id) pending.phase = "unapplied";
        if (this.active === entry) this.active = undefined;
        this.changed();
      }
    }, controller.signal);
    try { return await Promise.race([scheduled, cancellation]); }
    finally {
      options.signal?.removeEventListener("abort", externalAbort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) if (entry.phase === "pending" || entry.phase === "unapplied") {
      entry.phase = "cancelled"; entry.controller?.abort();
    }
    this.changed();
  }
}
