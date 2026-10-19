import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readArchive, describe } from '../src/skills/import.js';
import { publicAddress, validateRemote, importRemote } from '../src/skills/network.js';
import { SkillError } from '../src/skills/types.js';
const skill = Buffer.from('---\nname: example\ndescription: Example guidance\n---\nSee references/guide.md');
// Minimal stored ZIP fixture, including UNIX mode attributes (no external test ZIP library).
function zip(entries: Array<{
    name: string;
    bytes: Buffer;
    mode?: number;
}>) {
    const locals: Buffer[] = [], centrals: Buffer[] = [];
    let offset = 0;
    for (const item of entries) {
        const name = Buffer.from(item.name), local = Buffer.alloc(30), central = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(item.bytes.length, 18);
        local.writeUInt32LE(item.bytes.length, 22);
        local.writeUInt16LE(name.length, 26);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(item.bytes.length, 20);
        central.writeUInt32LE(item.bytes.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, item.bytes);
        centrals.push(central, name);
        offset += local.length + name.length + item.bytes.length;
    }
    const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}
test('ZIP import preserves references and rejects traversal, symlinks, duplicates and multiple skills', async () => {
    const files = await readArchive(zip([{ name: 'example/SKILL.md', bytes: skill }, { name: 'example/references/guide.md', bytes: Buffer.from('guide') }]));
    assert.equal(files.get('references/guide.md')?.toString(), 'guide');
    for (const entries of [
        [{ name: '../SKILL.md', bytes: skill }],
        [{ name: '/SKILL.md', bytes: skill }],
        [{ name: 'SKILL.md', bytes: skill }, { name: 'escape', bytes: Buffer.from('/etc/passwd'), mode: 0o120777 }],
        [{ name: 'SKILL.md', bytes: skill }, { name: 'SKILL.md', bytes: skill }],
        [{ name: 'SKILL.md', bytes: skill }, { name: 'other/SKILL.md', bytes: skill }],
        [{ name: 'skill/SKILL.md', bytes: skill }, { name: 'outside.md', bytes: skill }],
        [],
    ])
        await assert.rejects(readArchive(zip(entries)));
    await assert.rejects(readArchive(zip([{ name: 'SKILL.md', bytes: skill }, ...Array.from({ length: 200 }, (_, i) => ({ name: `${i}.md`, bytes: Buffer.from('a') }))])));
});
test('all DNS answers must be public and special IPv4/IPv6 addresses fail closed', async () => {
    for (const address of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::'])
        assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress('8.8.8.8'), true);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
    await assert.rejects(validateRemote(new URL('https://example.test'), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /nonpublic/);
    for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://example.test:8443', 'https://127.0.0.1'])
        await assert.rejects(validateRemote(new URL(url), async () => [{ address: '8.8.8.8', family: 4 }]));
});
test('GitHub slash branch resolves immutable commit and includes reference files', async () => {
    const sha = 'a'.repeat(40);
    const seen: string[] = [];
    const files = await importRemote('https://github.com/acme/repo/tree/feature/skills/my-skill', async (input) => {
        seen.push(input);
        let data: any;
        if (input.endsWith('/commits/feature%2Fskills%2Fmy-skill'))
            throw new SkillError('not found', 404);
        if (input.endsWith('/commits/feature%2Fskills'))
            data = { sha };
        else if (input.endsWith(`/git/trees/${sha}?recursive=1`))
            data = { truncated: false, tree: [{ path: 'my-skill/SKILL.md', type: 'blob', mode: '100644', size: skill.length }, { path: 'my-skill/references/guide.md', type: 'blob', mode: '100644', size: 5 }, { path: 'unrelated/SKILL.md', type: 'blob', mode: '100644', size: 100 }] };
        else if (input.endsWith('/my-skill/SKILL.md'))
            return { bytes: skill, url: new URL(input), contentType: 'text/plain' };
        else if (input.endsWith('/my-skill/references/guide.md'))
            return { bytes: Buffer.from('guide'), url: new URL(input), contentType: 'text/plain' };
        else
            assert.fail(`Unexpected request ${input}`);
        return { bytes: Buffer.from(JSON.stringify(data)), url: new URL(input), contentType: 'application/json' };
    });
    assert.equal(files.files.get('references/guide.md')?.toString(), 'guide');
    assert(seen.filter(url => url.includes('raw.githubusercontent')).every(url => url.includes(sha)));
});
test('frontmatter honors invocation flag while rejecting invalid UTF-8 and nonboolean flags', () => {
    const data = new Map([['SKILL.md', Buffer.from('---\nname: example\ndescription: Example\ndisable-model-invocation: true\nallowed-tools: all\n---\nbody')]]);
    assert.equal(describe(data, { kind: 'file', label: 'SKILL.md' }).skill.disableModelInvocation, true);
    assert.throws(() => describe(new Map([['SKILL.md', Buffer.from([0xff])]]), { kind: 'file', label: 'SKILL.md' }));
    assert.throws(() => describe(new Map([['SKILL.md', Buffer.from('---\nname: example\ndescription: Example\ndisable-model-invocation: "true"\n---\nbody')]]), { kind: 'file', label: 'SKILL.md' }));
});
test('plain HTTPS does not silently import ZIPs and warns that references are absent', async () => {
    await assert.rejects(importRemote('https://example.test/skill.zip', async (input) => ({ bytes: zip([{ name: 'SKILL.md', bytes: skill }]), url: new URL(input), contentType: 'application/zip' })), /SKILL.md|ZIP/i);
    const result = await importRemote('https://example.test/SKILL.md', async (input) => ({ bytes: skill, url: new URL(input), contentType: 'text/plain' }));
    assert(describe(result.files, result.source).warnings.some(w => /reference|attachment/i.test(w)));
});
test('invalid UTF-8 raises an actionable SkillError', () => {
    assert.throws(() => describe(new Map([['SKILL.md', Buffer.from([0xff])]]), { kind: 'file', label: 'SKILL.md' }), (error: any) => error instanceof SkillError && error.status === 400);
});
test('network transport pins the validated address and blocks private redirect before opening a socket', async (t) => {
    const { default: https } = await import('node:https');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const { downloadRemote } = await import('../src/skills/network.js');
    let lookups = 0;
    let requests = 0;
    let pin: string | undefined;
    t.mock.method(https, 'get', ((url: URL, options: any, callback: any) => {
        requests++;
        options.lookup(url.hostname, { all: false }, (error: any, address: string) => { assert.equal(error, null); pin = address; });
        const request = new EventEmitter() as any;
        request.destroy = (error: any) => request.emit('error', error);
        queueMicrotask(() => { const response = new PassThrough() as any; response.statusCode = 302; response.headers = { location: 'https://169.254.169.254/latest/meta-data' }; callback(response); request.emit('close'); });
        return request;
    }) as any);
    await assert.rejects(downloadRemote('https://public.example/SKILL.md', async () => { lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; }), /nonpublic/);
    assert.equal(requests, 1);
    assert.equal(pin, '8.8.8.8');
    assert.equal(lookups, 1);
});
test('GitHub total download cap includes metadata and raw content', async () => {
    const sha = 'b'.repeat(40);
    let raw = 0;
    await assert.rejects(importRemote('https://github.com/acme/repo/tree/main/skill', async (input) => {
        let bytes: Buffer;
        if (input.endsWith('/commits/main%2Fskill'))
            throw new SkillError('not found', 404);
        if (input.endsWith('/commits/main'))
            bytes = Buffer.from(JSON.stringify({ sha }));
        else if (input.includes('/git/trees/'))
            bytes = Buffer.from(JSON.stringify({ tree: [{ path: 'skill/SKILL.md', type: 'blob', mode: '100644', size: 1 }, { path: 'skill/reference.md', type: 'blob', mode: '100644', size: 1 }] }));
        else {
            raw++;
            bytes = Buffer.alloc(11 * 1024 * 1024);
        }
        return { bytes, url: new URL(input), contentType: 'text/plain' };
    }), /20 MiB/);
    assert.equal(raw, 2);
});
test('content hashes and manifests are identical across process locale settings', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const moduleUrl = new URL('../src/skills/import.ts', import.meta.url).href;
    const script = `import {describe} from ${JSON.stringify(moduleUrl)};const files=new Map([['ä.md',Buffer.from('a')],['z.md',Buffer.from('z')],['SKILL.md',Buffer.from('---\\nname: example\\ndescription: Example\\n---\\nbody')]]);console.log(JSON.stringify(describe(files,{kind:'file',label:'SKILL.md'}).skill));`;
    const results = await Promise.all(['en_US.UTF-8', 'sv_SE.UTF-8'].map(locale => run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { env: { ...process.env, LANG: locale, LC_ALL: locale } })));
    const [english, swedish] = results.map(result => JSON.parse(result.stdout));
    assert.equal(english.version, swedish.version);
    assert.deepEqual(english.files.map((file: any) => file.path), ['SKILL.md', 'z.md', 'ä.md']);
    assert.deepEqual(swedish.files, english.files);
});
