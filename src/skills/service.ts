import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, realpath, readdir, lstat, rm, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';
import { SkillError, type SkillConfirmation, type SkillImportInput, type SkillLibrary, type SkillPatch, type SkillPreview, type SkillSnapshot, type SkillVersion, type SkillSource } from './types.js';
import { describe, readArchive, readDirectory, versionFor, MAX_BYTES, type SkillFiles } from './import.js';
import { importRemote } from './network.js';
interface Project {
    revision: number;
    bindings: Record<string, {
        version: string;
        enabled: boolean;
    }>;
}
interface StoredPreview {
    preview: SkillPreview;
    reviewedBinding?: {
        version: string;
        enabled: boolean;
    };
    confirmation?: SkillConfirmation;
}
interface State {
    format: 1;
    versions: Record<string, Record<string, SkillVersion>>;
    projects: Record<string, Project>;
    previews: Record<string, StoredPreview>;
}
interface Candidate {
    localId: string;
    name: string;
    description: string;
    source: string;
    path: string;
}
const TTL = 15 * 60 * 1000;
function emptyState(): State { return { format: 1, versions: {}, projects: {}, previews: {} }; }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
export class SkillService {
    private readonly dataDir: string;
    private readonly now: () => number;
    private readonly homeDir: string;
    constructor(options: {
        dataDir?: string;
        now?: () => number;
        homeDir?: string;
    } = {}) {
        this.dataDir = resolve(options.dataDir ?? process.env.CODE_ANALYZER_DATA_DIR ?? join(homedir(), '.code-analyzer'), 'skills');
        this.now = options.now ?? Date.now;
        this.homeDir = options.homeDir ?? homedir();
    }
    private async canonical(project: string): Promise<string> {
        if (!project || typeof project !== 'string')
            throw new SkillError('Project path is required');
        try {
            const path = await realpath(project);
            if (!(await lstat(path)).isDirectory())
                throw new Error();
            return path;
        }
        catch {
            throw new SkillError('Project directory does not exist', 404);
        }
    }
    private async locked<T>(operation: (state: State) => Promise<T>): Promise<T> {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const release = await lockfile.lock(this.dataDir, { realpath: true, stale: 30000, update: 10000, retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } });
        try {
            let state: State;
            try {
                state = JSON.parse(await readFile(join(this.dataDir, 'state.json'), 'utf8'));
                if (state.format !== 1)
                    throw new Error('Unsupported skills storage version');
            }
            catch (error) {
                if (!missing(error))
                    throw error;
                state = emptyState();
            }
            return await operation(state);
        }
        finally {
            await release();
        }
    }
    private async save(state: State): Promise<void> {
        const target = join(this.dataDir, 'state.json'), temp = target + '.' + randomUUID() + '.tmp';
        const file = await open(temp, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(state));
            await file.sync();
        }
        finally {
            await file.close();
        }
        try {
            await rename(temp, target);
        }
        finally {
            await rm(temp, { force: true });
        }
    }
    private project(state: State, path: string): Project { return state.projects[digest(path)] ?? { revision: 0, bindings: {} }; }
    private versionDir(id: string, version: string): string { return join(this.dataDir, 'versions', id, version); }
    private makeSnapshot(state: State, path: string): SkillSnapshot {
        const project = this.project(state, path);
        return { projectPath: path, revision: project.revision, skills: Object.entries(project.bindings).filter(([, binding]) => binding.enabled).map(([id, binding]) => {
                const skill = state.versions[id]?.[binding.version];
                if (!skill)
                    throw new SkillError('Skill store is inconsistent', 500);
                const baseDir = this.versionDir(id, binding.version);
                return { ...skill, baseDir, filePath: join(baseDir, 'SKILL.md') };
            }).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    async snapshot(project: string): Promise<SkillSnapshot> { const path = await this.canonical(project); return this.locked(async (state) => this.makeSnapshot(state, path)); }
    async list(project: string): Promise<SkillLibrary> {
        const path = await this.canonical(project);
        const local = await this.discover(path);
        return this.locked(async (state) => {
            const current = this.project(state, path);
            const installed = Object.entries(state.versions).flatMap(([id, versions]) => Object.values(versions).map(skill => ({ ...skill, enabled: current.bindings[id]?.enabled === true && current.bindings[id].version === skill.version }))).sort((a, b) => a.name.localeCompare(b.name) || b.installedAt.localeCompare(a.installedAt));
            return { projectPath: path, revision: current.revision, installed, local: local.map(({ path: _, ...item }) => item) };
        });
    }
    async prepare(project: string, input: SkillImportInput): Promise<SkillPreview> {
        try {
            return await this.prepareInput(project, input);
        }
        catch (error) {
            if (error instanceof SkillError)
                throw error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT')
                throw new SkillError('Skill source was not found', 404);
            if (code === 'EACCES' || code === 'EPERM')
                throw new SkillError('Skill source cannot be read', 400);
            throw new SkillError('Unable to prepare skill import; check the source and retry', 400);
        }
    }
    private async prepareInput(project: string, input: SkillImportInput): Promise<SkillPreview> {
        const path = await this.canonical(project);
        let files: SkillFiles, source: SkillSource;
        if (input.kind === 'upload') {
            const bytes = Buffer.from(input.bytes);
            if (bytes.length > MAX_BYTES)
                throw new SkillError('Upload exceeds 20 MiB');
            const filename = basename(input.filename);
            if (filename.toLowerCase().endsWith('.zip')) {
                files = await readArchive(bytes);
                source = { kind: 'zip', label: filename };
            }
            else if (filename === 'SKILL.md') {
                files = new Map([['SKILL.md', bytes]]);
                source = { kind: 'file', label: filename };
            }
            else
                throw new SkillError('Upload SKILL.md or a single-skill ZIP');
        }
        else if (input.kind === 'url') {
            ({ files, source } = await importRemote(input.url));
        }
        else if (input.kind === 'local') {
            const found = (await this.discover(path)).find(candidate => candidate.localId === input.localId);
            if (!found)
                throw new SkillError('Local skill candidate not found', 404);
            files = await readDirectory(found.path);
            source = { kind: 'local', label: found.source };
        }
        else if (input.kind === 'path') {
            const target = resolve(path, input.path);
            const stat = await lstat(target);
            if (stat.isSymbolicLink())
                throw new SkillError('Symbolic links are not allowed in skills');
            if (stat.isDirectory()) {
                files = await readDirectory(target);
            }
            else if (basename(target) === 'SKILL.md') {
                files = await readDirectory(dirname(target));
            }
            else if (target.toLowerCase().endsWith('.zip')) {
                if (!stat.isFile()) throw new SkillError('Only regular ZIP files are allowed');
                if (stat.size > MAX_BYTES)
                    throw new SkillError('Archive exceeds 20 MiB');
                files = await readArchive(await readFile(target));
            }
            else
                throw new SkillError('Use a skill directory, SKILL.md, or ZIP');
            source = { kind: 'local', label: target };
        }
        else
            throw new SkillError('Unsupported skill input');
        const metadata = describe(files, source);
        const id = randomUUID();
        return this.locked(async (state) => {
            // Keep idempotency receipts, but discard expired preview payloads lazily.
            for (const [previewId, stored] of Object.entries(state.previews)) {
                if (!stored.confirmation && this.now() >= Date.parse(stored.preview.expiresAt))
                    await rm(join(this.dataDir, 'previews', previewId), { recursive: true, force: true });
            }
            const binding = this.project(state, path).bindings[metadata.skill.id];
            const old = binding && state.versions[metadata.skill.id]?.[binding.version];
            const preview: SkillPreview = { id, projectPath: path, ...metadata, expiresAt: new Date(this.now() + TTL).toISOString(), ...(old ? { replacement: { id: old.id, name: old.name, version: old.version } } : {}) };
            const stage = join(this.dataDir, 'previews', id);
            try { await this.writeFiles(stage, files); }
            catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
            state.previews[id] = { preview, ...(binding ? { reviewedBinding: { ...binding } } : {}) };
            try {
                await this.save(state);
            }
            catch (error) {
                await rm(stage, { recursive: true, force: true });
                throw error;
            }
            return preview;
        });
    }
    private async writeFiles(target: string, files: SkillFiles): Promise<void> {
        await mkdir(target, { recursive: true, mode: 0o700 });
        for (const [path, bytes] of files) {
            const full = join(target, path);
            await mkdir(dirname(full), { recursive: true, mode: 0o700 });
            const file = await open(full, 'wx', 0o400);
            try { await file.writeFile(bytes); await file.sync(); }
            finally { await file.close(); }
        }
    }
    async confirm(id: string): Promise<SkillConfirmation> {
        if (!/^[0-9a-f-]{36}$/.test(id))
            throw new SkillError('Skill preview not found', 404);
        return this.locked(async (state) => {
            const stored = state.previews[id];
            if (!stored)
                throw new SkillError('Skill preview not found', 404);
            if (stored.confirmation)
                return stored.confirmation;
            const preview = stored.preview;
            if (this.now() >= Date.parse(preview.expiresAt))
                throw new SkillError('Skill preview expired; prepare it again', 410);
            // Project identity and preview bytes are fixed at prepare time.
            if (await this.canonical(preview.projectPath) !== preview.projectPath)
                throw new SkillError('Preview project identity changed', 409);
            const current = this.project(state, preview.projectPath).bindings[preview.skill.id];
            const alreadyEnabled = current?.version === preview.skill.version && current.enabled;
            const bindingChanged = current?.version !== stored.reviewedBinding?.version || current?.enabled !== stored.reviewedBinding?.enabled;
            if (!alreadyEnabled && bindingChanged)
                throw new SkillError('Project skill binding changed; prepare again before confirming', 409);
            const stage = join(this.dataDir, 'previews', id), files = await readDirectory(stage);
            if (versionFor(files) !== preview.skill.version)
                throw new SkillError('Skill preview content changed', 409);
            const skill: SkillVersion = state.versions[preview.skill.id]?.[preview.skill.version] ?? { ...preview.skill, installedAt: new Date(this.now()).toISOString() };
            const target = this.versionDir(skill.id, skill.version);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            try {
                await lstat(target);
                if (versionFor(await readDirectory(target)) !== skill.version)
                    throw new SkillError('Stored skill content changed', 409);
            }
            catch (error) {
                if (!missing(error))
                    throw error;
                const temp = target + '.' + randomUUID() + '.tmp';
                try {
                    await this.writeFiles(temp, files);
                    await rename(temp, target);
                }
                finally {
                    await rm(temp, { recursive: true, force: true });
                }
            }
            state.versions[skill.id] ??= {};
            state.versions[skill.id][skill.version] = skill;
            const project = state.projects[digest(preview.projectPath)] ??= { revision: 0, bindings: {} };
            const old = project.bindings[skill.id];
            if (!old || !old.enabled || old.version !== skill.version) {
                project.bindings[skill.id] = { version: skill.version, enabled: true };
                project.revision++;
            }
            const confirmation: SkillConfirmation = { previewId: id, installed: skill, snapshot: this.makeSnapshot(state, preview.projectPath) };
            stored.confirmation = confirmation;
            await this.save(state);
            await rm(stage, { recursive: true, force: true });
            return confirmation;
        });
    }
    async patch(id: string, input: SkillPatch): Promise<SkillSnapshot> {
        if (!/^[0-9a-f]{64}$/.test(id))
            throw new SkillError('Skill not found', 404);
        if (input.version !== undefined && (typeof input.version !== 'string' || !/^[0-9a-f]{64}$/.test(input.version)))
            throw new SkillError('Skill version not found', 404);
        const path = await this.canonical(input.project);
        if (typeof input.enabled !== 'boolean')
            throw new SkillError('enabled must be boolean');
        return this.locked(async (state) => {
            const versions = state.versions[id];
            if (!Object.hasOwn(state.versions, id))
                throw new SkillError('Skill not found', 404);
            const project = state.projects[digest(path)] ??= { revision: 0, bindings: {} };
            const version = input.version ?? project.bindings[id]?.version ?? Object.values(versions).sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0]?.version;
            if (!version || !Object.hasOwn(versions, version))
                throw new SkillError('Skill version not found', 404);
            const old = project.bindings[id];
            if (!old || old.enabled !== input.enabled || old.version !== version) {
                project.bindings[id] = { version, enabled: input.enabled };
                project.revision++;
                await this.save(state);
            }
            return this.makeSnapshot(state, path);
        });
    }
    private async discover(project: string): Promise<Candidate[]> {
        const roots = [join(project, '.agents', 'skills'), join(project, '.pi', 'skills'), join(this.homeDir, '.agents', 'skills'), join(this.homeDir, '.pi', 'agent', 'skills'), ...(process.env.PI_CODING_AGENT_DIR ? [join(resolve(process.env.PI_CODING_AGENT_DIR), 'skills')] : [])];
        const candidates: Candidate[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            try {
                if ((await lstat(root)).isSymbolicLink())
                    continue;
                const entries = await readdir(root, { withFileTypes: true });
                const dirs = entries.some(e => e.isFile() && e.name === 'SKILL.md') ? [root] : entries.filter(e => e.isDirectory()).slice(0, MAX_FILES_FOR_DISCOVERY).map(e => join(root, e.name));
                for (const dir of dirs) {
                    try {
                        const canonical = await realpath(dir);
                        if (seen.has(canonical))
                            continue;
                        seen.add(canonical);
                        const stat = await lstat(join(dir, 'SKILL.md'));
                        if (!stat.isFile() || stat.size > 256 * 1024)
                            continue;
                        const skill = describe(new Map([['SKILL.md', await readFile(join(dir, 'SKILL.md'))]]), { kind: 'local', label: dir }).skill;
                        candidates.push({ localId: digest(canonical), name: skill.name, description: skill.description, source: dir, path: dir });
                    }
                    catch { /* Invalid candidates are not executable or listed. */ }
                }
            }
            catch (error) {
                if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'EACCES')
                    throw error;
            }
        }
        return candidates;
    }
}
const MAX_FILES_FOR_DISCOVERY = 200;
const instances = new Map<string, SkillService>();
export const getSkillService = (): SkillService => { const dataDir = resolve(process.env.CODE_ANALYZER_DATA_DIR ?? join(homedir(), '.code-analyzer')); let service = instances.get(dataDir); if (!service) {
    service = new SkillService({ dataDir });
    instances.set(dataDir, service);
} return service; };
