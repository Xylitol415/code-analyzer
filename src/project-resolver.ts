import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CACHE_DIR = join(homedir(), ".code-analyzer", "repos");

export interface ResolvedProject {
  /** 分析工具实际作用的目录（本地路径，或 clone 后的缓存目录）。 */
  cwd: string;
  /** 原始输入。 */
  source: string;
  /** 本次是否执行了 clone。 */
  cloned: boolean;
}

export function isGitUrl(input: string): boolean {
  return /^(https?|git|ssh):\/\//i.test(input) || /^git@[\w.-]+:.+/.test(input);
}

/**
 * 识别输入是远程 URL 还是本地路径。
 * - URL：clone（浅克隆）到 `~/.code-analyzer/repos/<hash>`，已存在则复用。
 * - 本地路径：校验存在且是 git 仓库。
 */
export function resolveProject(input: string): ResolvedProject {
  if (isGitUrl(input)) {
    const hash = createHash("sha256").update(input).digest("hex").slice(0, 12);
    const dir = join(CACHE_DIR, hash);

    if (existsSync(join(dir, ".git"))) {
      return { cwd: dir, source: input, cloned: false };
    }

    mkdirSync(dir, { recursive: true });
    console.log(`正在 clone ${input} ...`);
    execFileSync("git", ["clone", "--depth", "1", input, dir], { stdio: "inherit" });
    return { cwd: dir, source: input, cloned: true };
  }

  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw new Error(`路径不存在：${abs}`);
  }
  if (!existsSync(join(abs, ".git"))) {
    throw new Error(`"${abs}" 不是 git 仓库（未找到 .git 目录）`);
  }
  return { cwd: abs, source: abs, cloned: false };
}
