import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { finishSessionSkillsTurn, refreshSessionSkills } from "./skills/runtime.js";
import type { SkillPreview, SkillSnapshot } from "./skills/types.js";
import { completeMemoryTurn, finishMemoryTurn, prepareMemoryTurn, StaleContextError, MemoryRequestError, type AskOptions } from "./memory/runtime.js";
import { MemoryError } from "./memory/errors.js";
import type { AnswerMetadata, SourceSnapshot } from "./memory/types.js";
export type { AskOptions } from "./memory/runtime.js";

export type AskEvent = AgentSessionEvent
  | { type: "skills_applied"; snapshot: SkillSnapshot }
  | { type: "skill_preview"; preview: SkillPreview }
  | { type: "answer_reused"; answer: string; metadata: AnswerMetadata };

export interface AskOutcome {
  answer: string;
  metadata?: AnswerMetadata;
  snapshot?: SourceSnapshot;
  skillPreviews?: SkillPreview[];
  toolCalls: Array<{ name: string; args: unknown; isError: boolean; ms: number }>;
}

export async function runAsk(
  session: Pick<AgentSession, "prompt" | "subscribe">,
  question: string,
  onEvent?: (e: AskEvent) => void,
  signal?: AbortSignal,
  options: AskOptions = {},
): Promise<AskOutcome> {
  let answer = "";
  let settledAnswer: string | undefined;
  let providerFailure: string | undefined;
  const toolCalls: AskOutcome["toolCalls"] = [];
  const skillPreviews: SkillPreview[] = [];
  const startInfo = new Map<string, { start: number; args: unknown }>();

  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") answer += ev.delta;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      settledAnswer = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      // prompt() can resolve even when the provider returned an error. A
      // successful SDK retry replaces the earlier failure before we return.
      providerFailure = (event.message.stopReason === "error" || event.message.stopReason === "aborted")
        ? event.message.errorMessage || "请求失败，请检查 LLM BaseURL、API Key 和模型名"
        : undefined;
    } else if (event.type === "tool_execution_start") {
      startInfo.set(event.toolCallId, { start: Date.now(), args: event.args });
    } else if (event.type === "tool_execution_end") {
      const preview = (event.result?.details as { skillPreview?: SkillPreview } | undefined)?.skillPreview;
      if (!event.isError && preview && event.toolName === "prepare_skill_import" && !skillPreviews.some((item) => item.id === preview.id)) {
        skillPreviews.push(preview);
        onEvent?.({ type: "skill_preview", preview });
      }
      const info = startInfo.get(event.toolCallId);
      toolCalls.push({
        name: event.toolName,
        args: info?.args,
        isError: event.isError,
        ms: info ? Date.now() - info.start : 0,
      });
    }
    onEvent?.(event);
  });

  try {
    signal?.throwIfAborted();
    const prompt = question.replace(/^\/skill(?::|\s+)(\S+)(?:\s+|$)/, "/skill:$1 ");
    const snapshot = await refreshSessionSkills(session, prompt, signal);
    if (snapshot) onEvent?.({ type: "skills_applied", snapshot });
    signal?.throwIfAborted();
    try {
      const reused = await prepareMemoryTurn(session, question, options, signal);
      if (reused) {
        onEvent?.({ type: "answer_reused", answer: reused.answer, metadata: reused.metadata });
        return { ...reused, toolCalls };
      }
    } catch (error) {
      if (!(error instanceof MemoryError && error.status === 503) || signal?.aborted) throw error;
      // Native storage/index failures must not disable ordinary analysis.
      finishMemoryTurn(session);
    }
    await session.prompt(prompt, {
      // pi 0.87.1 calls this synchronously after async preparation and just
      // before starting the agent. abort() alone cannot cancel that preparation.
      preflightResult: () => signal?.throwIfAborted(),
    });
    if (providerFailure) throw new Error(`模型服务请求失败：${providerFailure}`);
    signal?.throwIfAborted();
    answer = settledAnswer ?? answer;
    try {
      const completed = await completeMemoryTurn(session);
      if (completed) return { ...completed, toolCalls, ...(skillPreviews.length ? { skillPreviews } : {}) };
    } catch (error) {
      if (error instanceof StaleContextError || error instanceof MemoryRequestError) throw error;
    }
  } finally {
    finishMemoryTurn(session);
    finishSessionSkillsTurn(session);
    unsub();
  }
  return { answer, toolCalls, ...(skillPreviews.length ? { skillPreviews } : {}) };
}

