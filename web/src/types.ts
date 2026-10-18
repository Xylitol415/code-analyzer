export type SseEventName = "thinking" | "tool" | "text" | "done" | "error";

export interface ToolCall {
  name: string;
  args?: unknown;
  /** undefined=进行中，false=成功，true=失败 */
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  tools: ToolCall[];
  error?: string;
  streaming: boolean;
}
