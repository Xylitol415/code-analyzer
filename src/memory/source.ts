import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, posix } from 'node:path';
import { readonlyGitInvocation } from '../git-tool.js';
import { MemoryError } from './errors.js';
import type { SourceSnapshot, SourceEvidence, SourceEvidenceInput } from './types.js';

function git(cwd: string, command: string, args: string[]): string {
  return execFileSync('git', readonlyGitInvocation(cwd, command, args), {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Run only in the memory worker: all Git commands use the shared read-only guard. */
export function snapshotSource(project: string): SourceSnapshot {
  try {
    const selected = realpathSync(project);
    const projectPath = selected;
    const repository = realpathSync(git(selected, 'rev-parse', ['--show-toplevel']).trim());
    const commit = git(repository, 'rev-parse', ['--verify', 'HEAD']).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid HEAD');
    const branch = git(repository, 'rev-parse', ['--abbrev-ref', 'HEAD']).trim();
    const status = git(repository, 'status', ['--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
    const flags = git(repository, 'ls-files', ['--debug', '-z']);
    const hidden = [...flags.matchAll(/flags: ([0-9a-f]+)/g)].some(match => match[1] !== '0');
    const stages = git(repository, 'ls-files', ['--stage', '-z']).split('\0').filter(Boolean);
    const submodule = stages.some(line => line.startsWith('160000 '));
    const reason = status ? 'Working tree has changes or untracked files' : hidden ? 'Unsupported hidden Git index flags' : submodule ? 'Submodules are unsupported' : undefined;
    const projectId = hash(projectPath);
    return { projectPath, projectId, branch, commit, key: hash(JSON.stringify([projectId, branch, commit])), clean: !reason, ...(reason ? { reason } : {}) };
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError('Cannot safely snapshot Git project', 400);
  }
}

export function readSourceEvidence(snapshot: SourceSnapshot, inputs: SourceEvidenceInput[]): SourceEvidence[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20) throw new MemoryError('Tracked source evidence is required (1–20 ranges)', 400);
  return inputs.map(input => {
    if (!input || typeof input.path !== 'string' || isAbsolute(input.path) || input.path.includes('\\') || input.path.includes('\0') || posix.normalize(input.path) !== input.path || input.path.split('/').some(p => p === '..' || p === '.git') || input.path.startsWith('-') || !Number.isInteger(input.startLine) || !Number.isInteger(input.endLine) || input.startLine < 1 || input.endLine < input.startLine || input.endLine - input.startLine > 1000) throw new MemoryError('Invalid source evidence path or line range', 400);
    try {
      const prefix = git(snapshot.projectPath, 'rev-parse', ['--show-prefix']).trim();
      const treePath = prefix + input.path;
      const repository = git(snapshot.projectPath, 'rev-parse', ['--show-toplevel']).trim();
      const tree = git(repository, 'ls-tree', ['-z', snapshot.commit, '--', treePath]).split('\0').filter(Boolean);
      const entry = tree.length === 1 ? /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(tree[0]) : null;
      if (!entry || entry[3] !== treePath) throw new Error('Not a regular tracked blob');
      const file = join(snapshot.projectPath, input.path);
      if (!lstatSync(file).isFile()) throw new Error('Evidence must be a regular working-tree file');
      const bytes = readFileSync(file);
      const actual = createHash(entry[2].length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== entry[2]) throw new Error('Working-tree evidence differs from reviewed commit');
      const content = git(snapshot.projectPath, 'cat-file', ['-p', entry[2]]);
      if (content.includes('\0')) throw new Error('Binary evidence');
      const lines = content.replace(/\n$/, '').split('\n');
      if (input.endLine > lines.length) throw new Error('Evidence line is outside blob');
      return { ...input, blobHash: entry[2], text: lines.slice(input.startLine - 1, input.endLine).join('\n') };
    } catch { throw new MemoryError('Evidence must refer to valid lines in a regular tracked Git blob', 400); }
  });
}
