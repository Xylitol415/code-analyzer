/** Shared host/transport contract. Skill bodies and credentials never belong in these DTOs. */
export interface SkillSource {
  kind: "file" | "zip" | "url" | "github" | "local";
  label: string;
}
export interface SkillVersion {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  disableModelInvocation: boolean;
  files: Array<{ path: string; size: number }>;
  installedAt: string;
}
export interface EnabledSkill extends SkillVersion { filePath: string; baseDir: string }
export interface SkillSnapshot { projectPath: string; revision: number; skills: EnabledSkill[] }
export interface SkillPreview {
  id: string;
  projectPath: string;
  skill: Omit<SkillVersion, "installedAt">;
  warnings: string[];
  replacement?: { id: string; name: string; version: string };
  expiresAt: string;
}
export interface SkillLibrary {
  projectPath: string;
  revision: number;
  installed: Array<SkillVersion & { enabled: boolean }>;
  local: Array<{ localId: string; name: string; description: string; source: string }>;
}
export type SkillImportInput =
  | { kind: "upload"; filename: string; bytes: Uint8Array }
  | { kind: "url"; url: string }
  | { kind: "local"; localId: string }
  | { kind: "path"; path: string }; // REPL host only, never accepted over HTTP/model tools.
export interface SkillConfirmation { previewId: string; installed: SkillVersion; snapshot: SkillSnapshot }
export interface SkillPatch { project: string; enabled: boolean; version?: string }
export class SkillError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "SkillError"; }
}
