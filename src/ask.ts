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
  const toolCalls: AskOutcome["toolCalls"] = [];
  const startInfo = new Map<string, { start: number; args: unknown }>();

  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") answer += ev.delta;
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
  } finally {
    unsub();
  }
  return { answer, toolCalls };
}

