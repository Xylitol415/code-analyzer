import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AskOutcome {
  answer: string;
  toolCalls: Array<{ name: string; args: unknown; isError: boolean; ms: number }>;
}

export async function runAsk(
  session: Pick<AgentSession, "prompt" | "subscribe">,
  question: string,
  onEvent?: (e: AgentSessionEvent) => void,
  signal?: AbortSignal,
): Promise<AskOutcome> {
  let answer = "";
  let providerFailure: string | undefined;
  const toolCalls: AskOutcome["toolCalls"] = [];
  const startInfo = new Map<string, { start: number; args: unknown }>();

  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") answer += ev.delta;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      // prompt() can resolve even when the provider returned an error. A
      // successful SDK retry replaces the earlier failure before we return.
      providerFailure = event.message.stopReason === "error"
        ? event.message.errorMessage || "请求失败，请检查 LLM BaseURL、API Key 和模型名"
        : undefined;
    } else if (event.type === "tool_execution_start") {
      startInfo.set(event.toolCallId, { start: Date.now(), args: event.args });
    } else if (event.type === "tool_execution_end") {
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
    await session.prompt(question, {
      // pi 0.87.1 calls this synchronously after async preparation and just
      // before starting the agent. abort() alone cannot cancel that preparation.
      preflightResult: () => signal?.throwIfAborted(),
    });
    if (providerFailure) throw new Error(`模型服务请求失败：${providerFailure}`);
  } finally {
    unsub();
  }
  return { answer, toolCalls };
}

