import type { SkillPreview } from "../../src/skills/types";
export type { SkillPreview, SkillVersion, SkillLibrary, SkillSnapshot, SkillConfirmation, SkillPatch } from "../../src/skills/types";

export type SseEventName = "thinking" | "tool" | "text" | "done" | "error" | "skill_preview" | "skills_applied";

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
  skillPreviews?: SkillPreview[];
  confirmedSkillPreviews?: string[];
  error?: string;
  streaming: boolean;
  /** 用户主动停止；已接收的正文、思考和工具记录仍保留。 */
  stopped?: boolean;
}
