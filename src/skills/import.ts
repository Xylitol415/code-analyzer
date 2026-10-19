import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import yauzl from 'yauzl';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { SkillError, type SkillVersion, type SkillSource } from './types.js';
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 200;
export const MAX_SKILL_BYTES = 256 * 1024;
export type SkillFiles = Map<string, Buffer>;
export function safePath(path: string): string {
    if (!path || path.length > 1024 || path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || !p))
        throw new SkillError('Unsafe skill file path');
    return path;
}
export function checkFiles(files: SkillFiles): void {
    if (files.size > MAX_FILES)
        throw new SkillError('Skill exceeds 200 files');
    let size = 0;
    const normalized = new Set<string>();
    for (const [path, bytes] of files) {
        safePath(path);
        size += bytes.length;
        const key = path.normalize('NFC').toLowerCase();
        if (normalized.has(key))
            throw new SkillError('Duplicate skill file path');
        normalized.add(key);
    }
    if (size > MAX_BYTES)
        throw new SkillError('Skill exceeds 20 MiB');
    const skill = files.get('SKILL.md');
    if (!skill)
        throw new SkillError('Skill requires a root SKILL.md');
    if (skill.length > MAX_SKILL_BYTES)
        throw new SkillError('SKILL.md exceeds 256 KiB');
    if ([...files.keys()].filter(p => posix.basename(p) === 'SKILL.md').length !== 1)
        throw new SkillError('Import must contain exactly one skill');
}
export function versionFor(files: SkillFiles): string {
    const hash = createHash('sha256');
    for (const [path, bytes] of [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
        hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}
export function describe(files: SkillFiles, source: SkillSource): {
    skill: Omit<SkillVersion, 'installedAt'>;
    warnings: string[];
} {
    checkFiles(files);
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(files.get('SKILL.md'));
    }
    catch {
        throw new SkillError('SKILL.md must contain valid UTF-8 text');
    }
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n'))
        throw new SkillError('SKILL.md requires YAML frontmatter');
    let meta: Record<string, unknown>;
    try {
        meta = parseFrontmatter<Record<string, unknown>>(text).frontmatter;
    }
    catch {
        throw new SkillError('Invalid SKILL.md frontmatter');
    }
    const name = meta.name, description = meta.description;
    if (typeof name !== 'string' || name.length > 64 || !(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).test(name))
        throw new SkillError('Skill name must be lowercase letters, digits, and single hyphens (max 64)');
    if (typeof description !== 'string' || !description.trim() || description.length > 1024)
        throw new SkillError('Skill description is required (max 1024 characters)');
    if (meta['disable-model-invocation'] !== undefined && typeof meta['disable-model-invocation'] !== 'boolean')
        throw new SkillError('disable-model-invocation must be boolean');
    const warnings = ['Skill content will become model instructions. Review and trust its source before confirming.', 'Scripts and allowed-tools declarations do not grant execution or additional permissions.'];
    if (source.kind === 'file' || source.kind === 'url')
        warnings.push('Only this SKILL.md is included; referenced files and attachments are not downloaded. Use a ZIP or GitHub directory to include them.');
    return { skill: { id: createHash('sha256').update(name).digest('hex'), name, description, version: versionFor(files), source, disableModelInvocation: meta['disable-model-invocation'] === true, files: [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))).map(([path, bytes]) => ({ path, size: bytes.length })) }, warnings };
}
export async function readDirectory(dir: string): Promise<SkillFiles> {
    const files: SkillFiles = new Map();
    let total = 0, entries = 0;
    async function walk(current: string, prefix: string): Promise<void> {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
            throw new SkillError('Symbolic links are not allowed in skills');
        if (!stat.isDirectory())
            throw new SkillError('Skill path must be a directory');
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (++entries > 1000)
                throw new SkillError('Too many skill directory entries');
            const rel = safePath(prefix + entry.name), full = join(current, entry.name);
            if (entry.isSymbolicLink())
                throw new SkillError('Symbolic links are not allowed in skills');
            if (entry.isDirectory()) {
                await walk(full, rel + '/');
                continue;
            }
            if (!entry.isFile())
                throw new SkillError('Only regular skill files are allowed');
            if (files.size >= MAX_FILES)
                throw new SkillError('Skill exceeds 200 files');
            const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.size + total > MAX_BYTES)
                    throw new SkillError('Skill exceeds 20 MiB or contains a nonregular file');
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of file.createReadStream({ autoClose: false })) {
                    size += chunk.length;
                    if (size + total > MAX_BYTES)
                        throw new SkillError('Skill exceeds 20 MiB');
                    chunks.push(chunk);
                }
                const bytes = Buffer.concat(chunks);
                total += size;
                files.set(rel, bytes);
            }
            finally {
                await file.close();
            }
        }
    }
    await walk(dir, '');
    checkFiles(files);
    return files;
}
export async function readArchive(bytes: Buffer): Promise<SkillFiles> {
    if (bytes.length > MAX_BYTES)
        throw new SkillError('Archive exceeds 20 MiB');
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
            if (error || !zip) {
                reject(new SkillError('Invalid ZIP archive'));
                return;
            }
            const files: SkillFiles = new Map(), seen = new Set<string>();
            let total = 0, count = 0, ended = false;
            const fail = (e: unknown) => { if (!ended) {
                ended = true;
                zip.close();
                reject(e instanceof SkillError ? e : new SkillError('Invalid ZIP archive'));
            } };
            zip.on('error', fail);
            zip.on('entry', entry => {
                void (async () => {
                    if (++count > 1000)
                        throw new SkillError('Too many archive entries');
                    const directory = entry.fileName.endsWith('/'), path = safePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
                    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
                    if ((mode !== 0 && mode !== 0x8000 && mode !== 0x4000) || (mode === 0x4000 && !directory) || (mode === 0x8000 && directory))
                        throw new SkillError('Archive links and special files are not allowed');
                    if (entry.generalPurposeBitFlag & 1)
                        throw new SkillError('Encrypted ZIP files are not allowed');
                    const key = path.normalize('NFC').toLowerCase();
                    if (seen.has(key))
                        throw new SkillError('Duplicate archive path');
                    seen.add(key);
                    if (directory) {
                        zip.readEntry();
                        return;
                    }
                    if (files.size >= MAX_FILES || entry.uncompressedSize + total > MAX_BYTES)
                        throw new SkillError('Archive exceeds file or size limit');
                    const content = await new Promise<Buffer>((res, rej) => zip.openReadStream(entry, (err, stream) => {
                        if (err || !stream) {
                            rej(err);
                            return;
                        }
                        const parts: Buffer[] = [];
                        let size = 0;
                        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (total + size > MAX_BYTES) {
                            stream.destroy(new SkillError('Archive exceeds 20 MiB'));
                            return;
                        } parts.push(chunk); });
                        stream.on('error', rej);
                        stream.on('end', () => res(Buffer.concat(parts)));
                    }));
                    total += content.length;
                    files.set(path, content);
                    zip.readEntry();
                })().catch(fail);
            });
            zip.on('end', () => {
                if (ended)
                    return;
                try {
                    const skillPaths = [...files.keys()].filter(p => posix.basename(p) === 'SKILL.md');
                    if (skillPaths.length !== 1)
                        throw new SkillError('Archive must contain exactly one SKILL.md');
                    const prefix = posix.dirname(skillPaths[0]);
                    let result = files;
                    if (prefix !== '.') {
                        if ([...files.keys()].some(p => !p.startsWith(prefix + '/')))
                            throw new SkillError('Files outside the skill directory are not allowed');
                        result = new Map([...files].map(([path, content]) => [path.slice(prefix.length + 1), content]));
                    }
                    checkFiles(result);
                    ended = true;
                    resolve(result);
                }
                catch (e) {
                    fail(e);
                }
            });
            zip.readEntry();
        });
    });
}
