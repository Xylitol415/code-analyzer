import { access } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import {
  createExtensionRuntime,
  defineTool,
  loadProjectContextFiles,
  stripFrontmatter,
  type AgentSession,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SkillImportInput, SkillPreview, SkillSnapshot } from "./types.js";

/** Minimal host dependency, also usable without provider credentials in tests. */
export interface SkillRuntimeService {
  snapshot(project: string): Promise<SkillSnapshot>;
  prepare(project: string, input: SkillImportInput): Promise<SkillPreview>;
}

/** No package resolver, extension discovery, templates, scripts, or implicit skills. */
export class ControlledSkillResourceLoader implements ResourceLoader {
  private readonly extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  private agentsFiles: Array<{ path: string; content: string }>;
  private current: SkillSnapshot;
  private originalTurnURLs = new Set<string>();

  constructor(
    readonly projectPath: string,
    private readonly agentDir: string,
    private readonly instructions: string,
    snapshot: SkillSnapshot,
  ) {
    this.current = snapshot;
    this.agentsFiles = loadProjectContextFiles({ cwd: projectPath, agentDir });
  }

  get snapshot(): SkillSnapshot { return this.current; }
  replaceSnapshot(snapshot: SkillSnapshot): void { this.current = snapshot; }
  beginTurn(question: string): void {
    // Extract from the original human input only; retrieved files/tool outputs never authorize network imports.
    this.originalTurnURLs.clear();
    this.addTurnInput(question);
  }
  addTurnInput(question: string): void {
    for (const url of question.match(/https:\/\/[^\s<>"'`\[\]()]+/g) ?? []) this.originalTurnURLs.add(url);
  }
  endTurn(): void { this.originalTurnURLs.clear(); }
  allowsURL(url: string): boolean { return this.originalTurnURLs.has(url); }
  getExtensions() { return this.extensions; }
  getSkills(): { skills: Skill[]; diagnostics: [] } {
    return {
      skills: this.current.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: { path: skill.filePath, source: "managed-skills", scope: "project", origin: "top-level", baseDir: skill.baseDir },
      })),
      diagnostics: [],
    };
  }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: this.agentsFiles }; }
  getSystemPrompt() { return undefined; }
  getSystemPromptSource() { return undefined; }
  getAppendSystemPrompt() { return [this.instructions]; }
  getAppendSystemPromptSources() { return []; }
  extendResources(): void { /* Runtime resources are exclusively managed by the host. */ }
  async reload(): Promise<void> {
    this.agentsFiles = loadProjectContextFiles({ cwd: this.projectPath, agentDir: this.agentDir });
  }
}

type BoundSession = Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName" | "sessionManager">;
const bindings = new WeakMap<object, { loader: ControlledSkillResourceLoader; service: SkillRuntimeService; session: BoundSession }>();

export function attachSessionSkills(session: BoundSession, loader: ControlledSkillResourceLoader, service: SkillRuntimeService): void {
  bindings.set(session, { session, loader, service });
}
export function getSessionSkills(session: object): SkillSnapshot | undefined { return bindings.get(session)?.loader.snapshot; }

/** Prepare against the current immutable snapshot; never reload a running turn. */
export function prepareSessionSkillSteering(session: object, question: string): string {
  const normalized = question.replace(/^\/skill(?::|\s+)(\S+)(?:\s+|$)/, "/skill:$1 ");
  if (!/^\/skill(?::|\s|$)/.test(normalized)) return question;
  const invocation = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(normalized);
  if (!invocation) throw Object.assign(new Error("请指定 Skill 名称：/skill:<名称> 问题"), { status: 400 });
  const skill = bindings.get(session)?.loader.snapshot.skills.find(entry => entry.name === invocation[1]);
  if (!skill) throw Object.assign(new Error(`Skill "${invocation[1]}" 未启用或不存在，请排队后刷新技能或选择已启用的技能。`), { status: 400 });
  let body: string;
  try { body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim(); }
  catch { throw Object.assign(new Error(`Skill "${skill.name}" 文件不可读，请重新导入后重试。`), { status: 400 }); }
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return invocation[2]?.trim() ? `${block}\n\n${invocation[2].trim()}` : block;
}
/** Only the actually adopted human input can add URL import authorization. */
export function applySessionSkillSteering(session: object, question: string): void {
  bindings.get(session)?.loader.addTurnInput(question);
}

/** Called inside the host's existing session queue immediately before prompt(). */
export async function refreshSessionSkills(session: object, question: string, signal?: AbortSignal): Promise<SkillSnapshot | undefined> {
  const binding = bindings.get(session);
  if (!binding) return undefined;
  const snapshot = await binding.service.snapshot(binding.loader.projectPath);
  signal?.throwIfAborted();
  binding.loader.replaceSnapshot(snapshot);
  binding.session.setActiveToolsByName(binding.session.getActiveToolNames());
  const invocation = /^\/skill:([^\s]+)(?:\s|$)/.exec(question);
  if (/^\/skill(?::|\s|$)/.test(question) && !invocation) throw new Error("请指定 Skill 名称：/skill <名称>，可用 /skills list 查看。");
  if (invocation) {
    const skill = snapshot.skills.find((entry) => entry.name === invocation[1]);
    if (!skill) throw new Error(`Skill "${invocation[1]}" 未启用或不存在。请用 /skills list 查看并启用后重试。`);
    try { await access(skill.filePath, constants.R_OK); }
    catch { throw new Error(`Skill "${skill.name}" 文件不可读，请重新导入后重试。`); }
    signal?.throwIfAborted();
  }
  binding.loader.beginTurn(question);
  binding.session.sessionManager.appendCustomEntry("skills_applied", {
    projectPath: snapshot.projectPath,
    revision: snapshot.revision,
    skills: snapshot.skills.map(({ id, name, version }) => ({ id, name, version })),
  });
  return snapshot;
}
export function finishSessionSkillsTurn(session: object): void { bindings.get(session)?.loader.endTurn(); }

export function createPrepareSkillImportTool(loader: ControlledSkillResourceLoader, service: SkillRuntimeService) {
  return defineTool({
    name: "prepare_skill_import",
    label: "预览 Skill 导入",
    description: "预览用户本轮原文提供的公开 HTTPS Skill URL。只暂存到应用数据目录，绝不写项目。必须等待用户在界面或 REPL 确认；模型不能确认、启用或安装包，也不能执行 Skill 脚本。",
    parameters: Type.Object({ url: Type.String({ description: "本轮用户原文中的完整 HTTPS URL" }) }),
    execute: async (_toolCallId, { url }, signal) => {
      signal?.throwIfAborted();
      if (!loader.allowsURL(url)) throw new Error("只能预览本轮用户原文提供的 HTTPS URL；请让用户直接提供完整 URL。");
      const preview = await service.prepare(loader.projectPath, { kind: "url", url });
      signal?.throwIfAborted();
      return {
        content: [{ type: "text" as const, text: `已准备 Skill 导入预览 ${preview.id}：${preview.skill.name}。等待用户确认，尚未导入或启用。` }],
        details: { skillPreview: preview },
      };
    },
  });
}
