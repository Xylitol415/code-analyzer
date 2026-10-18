import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { SkillError, type SkillSource } from './types.js';
import { MAX_BYTES, MAX_FILES, checkFiles, safePath, type SkillFiles } from './import.js';
export type Lookup = (hostname: string) => Promise<Array<{
    address: string;
    family: number;
}>>;
export function publicAddress(address: string): boolean {
    try {
        const ip = ipaddr.parse(address);
        return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || (ip as ipaddr.IPv6).match(ipaddr.parse('2000::') as ipaddr.IPv6, 3));
    }
    catch {
        return false;
    }
}
export async function validateRemote(url: URL, resolve: Lookup = host => lookup(host, { all: true })): Promise<{
    address: string;
    family: number;
}> {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
        throw new SkillError('Only public HTTPS URLs without credentials on port 443 are allowed');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: Array<{
        address: string;
        family: number;
    }>;
    try {
        addresses = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }] : await Promise.race([resolve(hostname), new Promise<never>((_ok, reject) => { timer = setTimeout(() => reject(new SkillError('Skill URL DNS lookup timed out')), 10000); timer.unref(); })]);
    }
    catch (error) {
        throw error instanceof SkillError ? error : new SkillError('Unable to resolve skill URL host');
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
    if (!addresses.length || addresses.some(a => !publicAddress(a.address)))
        throw new SkillError('目标域名解析到非公网地址（nonpublic）。请检查代理/DNS 的 fake-IP 配置，或上传 SKILL.md / ZIP。');
    return addresses[0];
}
export interface RemoteResponse {
    bytes: Buffer;
    url: URL;
    contentType: string;
}
export async function downloadRemote(input: string, resolve?: Lookup, maxBytes = MAX_BYTES): Promise<RemoteResponse> {
    let url: URL;
    try {
        url = new URL(input);
    }
    catch {
        throw new SkillError('Invalid skill URL');
    }
    for (let redirects = 0; redirects <= 5; redirects++) {
        const pinned = await validateRemote(url, resolve);
        const response = await new Promise<{
            status: number;
            location?: string;
            bytes: Buffer;
            contentType: string;
        }>((resolve, reject) => {
            const request = https.get(url, { agent: false, family: pinned.family, headers: { 'user-agent': 'code-analyzer-skills', 'accept-encoding': 'identity', accept: 'application/vnd.github+json, application/octet-stream, text/plain' }, lookup: ((_hostname: any, options: any, cb: any) => options?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)) as any }, res => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                    res.destroy();
                    resolve({ status, location: res.headers.location, bytes: Buffer.alloc(0), contentType: '' });
                    return;
                }
                if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
                    res.destroy();
                    reject(new SkillError('Compressed HTTP response is unsupported'));
                    return;
                }
                if (Number(res.headers['content-length']) > maxBytes) {
                    res.destroy();
                    reject(new SkillError('Download exceeds 20 MiB'));
                    return;
                }
                const parts: Buffer[] = [];
                let size = 0;
                res.on('data', (part: Buffer) => { size += part.length; if (size > maxBytes) {
                    res.destroy(new SkillError('Download exceeds 20 MiB'));
                    return;
                } parts.push(part); });
                res.on('error', reject);
                res.on('end', () => resolve({ status, bytes: Buffer.concat(parts), contentType: String(res.headers['content-type'] ?? '') }));
            });
            const deadline = setTimeout(() => request.destroy(new SkillError('Skill download timed out')), 30000);
            deadline.unref();
            request.on('close', () => clearTimeout(deadline));
            request.on('error', reject);
        });
        if (response.status >= 300 && response.status < 400) {
            if (!response.location)
                throw new SkillError('Invalid URL redirect');
            url = new URL(response.location, url);
            continue;
        }
        if (response.status !== 200)
            throw new SkillError(`Skill download returned HTTP ${response.status}`, response.status === 404 ? 404 : 400);
        return { bytes: response.bytes, url, contentType: response.contentType };
    }
    throw new SkillError('Too many URL redirects');
}
export type Download = typeof downloadRemote;
export async function importRemote(input: string, download: Download = downloadRemote): Promise<{
    files: SkillFiles;
    source: SkillSource;
}> {
    let url: URL;
    try {
        url = new URL(input);
    }
    catch {
        throw new SkillError('Invalid skill URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
        throw new SkillError('Only HTTPS URLs without credentials are allowed');
    const label = `${url.origin}${url.pathname}`;
    if (url.hostname === 'github.com')
        return { files: await githubDirectory(url, download), source: { kind: 'github', label } };
    const result = await download(input);
    const zip = result.bytes[0] === 0x50 && result.bytes[1] === 0x4b;
    if (zip)
        throw new SkillError('HTTPS imports require a single SKILL.md; upload ZIP archives through the host');
    const files = new Map([['SKILL.md', result.bytes]]);
    checkFiles(files);
    return { files, source: { kind: 'url', label } };
}
async function githubDirectory(url: URL, transport: Download): Promise<SkillFiles> {
    let downloaded = 0;
    const download: Download = async (input) => { const response = await transport(input, undefined, MAX_BYTES - downloaded); downloaded += response.bytes.length; if (downloaded > MAX_BYTES)
        throw new SkillError('GitHub import downloads exceed 20 MiB'); return response; };
    const parts = url.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p));
    if (parts.length < 2 || !parts.slice(0, 2).every(p => /^[A-Za-z0-9_.-]+$/.test(p)))
        throw new SkillError('Invalid GitHub repository URL');
    const [owner, repo] = parts;
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const json = async (path: string) => { const response = await download(api + path); try {
        return JSON.parse(response.bytes.toString('utf8'));
    }
    catch {
        throw new SkillError('Invalid GitHub response');
    } };
    let sha: string | undefined, folder = '';
    if (parts.length === 2) {
        const metadata = await json('');
        const commit = await json(`/commits/${encodeURIComponent(metadata.default_branch)}`);
        sha = commit.sha;
    }
    else {
        if (parts[2] !== 'tree' && parts[2] !== 'blob')
            throw new SkillError('Use a GitHub repository or tree directory URL');
        const tail = parts.slice(3);
        if (!tail.length || tail.length > 20)
            throw new SkillError('Invalid GitHub ref or path');
        // Resolve the longest valid ref, including branch and tag names containing slashes.
        for (let length = tail.length; length >= 1; length--) {
            try {
                const commit = await json(`/commits/${encodeURIComponent(tail.slice(0, length).join('/'))}`);
                sha = commit.sha;
                folder = tail.slice(length).join('/');
                break;
            }
            catch (error) {
                if (!(error instanceof SkillError) || error.status !== 404)
                    throw error;
            }
        }
        if (parts[2] === 'blob') {
            if (!folder.endsWith('/SKILL.md') && folder !== 'SKILL.md')
                throw new SkillError('GitHub file URL must target SKILL.md');
            folder = folder === 'SKILL.md' ? '' : folder.slice(0, -9);
        }
    }
    if (!sha || !/^[a-f0-9]{40,64}$/.test(sha))
        throw new SkillError('GitHub ref could not be resolved');
    if (folder)
        safePath(folder);
    const tree = await json(`/git/trees/${sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree))
        throw new SkillError('GitHub tree is incomplete; upload a single-skill ZIP instead');
    const prefix = folder ? folder + '/' : '';
    const entries = tree.tree.filter((e: any) => typeof e.path === 'string' && e.path.startsWith(prefix) && e.type !== 'tree');
    if (entries.length > MAX_FILES)
        throw new SkillError('Skill exceeds 200 files');
    const files: SkillFiles = new Map();
    let total = 0;
    for (const entry of entries) {
        if (entry.type !== 'blob' || entry.mode !== '100644' && entry.mode !== '100755')
            throw new SkillError('GitHub links and submodules are not allowed');
        const path = safePath(entry.path.slice(prefix.length));
        if (total + Number(entry.size) > MAX_BYTES)
            throw new SkillError('Skill exceeds 20 MiB');
        const response = await download(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`);
        total += response.bytes.length;
        if (total > MAX_BYTES)
            throw new SkillError('Skill exceeds 20 MiB');
        files.set(path, response.bytes);
    }
    checkFiles(files);
    return files;
}
