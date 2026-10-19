import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../src/skills/service.js';
const body = (text = 'Instructions') => Buffer.from(`---\nname: example\ndescription: Analyze examples\n---\n${text}\n`);
async function setup(t: any, now?: () => number) {
    const dir = await mkdtemp(join(tmpdir(), 'skills-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const project = join(dir, 'project');
    await mkdir(project);
    const dataDir = join(dir, 'data');
    return { dir, project, dataDir, service: new SkillService({ dataDir, now, homeDir: join(dir, 'home') }) };
}
test('preview cannot activate; confirmation persists and is idempotent across service instances', async (t) => {
    const { service, project, dataDir, dir } = await setup(t);
    const preview = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    assert.deepEqual((await service.snapshot(project)).skills, []);
    const confirmed = await service.confirm(preview.id);
    assert.equal(confirmed.snapshot.skills.length, 1);
    assert.equal(await readFile(confirmed.snapshot.skills[0].filePath, 'utf8'), body().toString());
    const restarted = new SkillService({ dataDir, homeDir: join(dir, 'home') });
    assert.deepEqual(await restarted.confirm(preview.id), confirmed);
    const other = join(dir, 'other');
    await mkdir(other);
    assert.deepEqual((await restarted.snapshot(other)).skills, []);
    await restarted.patch(confirmed.installed.id, { project, enabled: false });
    assert.equal((await service.snapshot(project)).skills.length, 0);
    assert.deepEqual(await service.confirm(preview.id), confirmed);
});
test('expired preview cannot publish and replacement versions are immutable', async (t) => {
    let now = Date.now();
    const { service, project } = await setup(t, () => now);
    const expired = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    now += 15 * 60 * 1000;
    await assert.rejects(service.confirm(expired.id), /expired/i);
    const a = await service.confirm((await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body('first') })).id);
    const b = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body('second') });
    assert.equal(b.replacement?.version, a.installed.version);
    const c = await service.confirm(b.id);
    assert.notEqual(c.installed.version, a.installed.version);
    assert.match(await readFile(a.snapshot.skills[0].filePath, 'utf8'), /first/);
    await service.patch(a.installed.id, { project, enabled: true, version: a.installed.version });
    assert.equal((await service.snapshot(project)).skills[0].version, a.installed.version);
});
test('local candidates require explicit import, include references, and reject symlinks', async (t) => {
    const { service, project, dir } = await setup(t);
    const local = join(project, '.agents', 'skills', 'example');
    await mkdir(join(local, 'references'), { recursive: true });
    await writeFile(join(local, 'SKILL.md'), body());
    await writeFile(join(local, 'references', 'guide.md'), 'guide');
    const library = await service.list(project);
    assert.equal(library.local.length, 1);
    assert.equal(library.installed.length, 0);
    const preview = await service.prepare(project, { kind: 'local', localId: library.local[0].localId });
    assert.deepEqual(preview.skill.files.map(f => f.path).sort(), ['SKILL.md', 'references/guide.md']);
    await writeFile(join(local, 'SKILL.md'), body('mutated'));
    const result = await service.confirm(preview.id);
    assert.doesNotMatch(await readFile(result.snapshot.skills[0].filePath, 'utf8'), /mutated/);
    await symlink(dir, join(local, 'escape'));
    await assert.rejects(service.prepare(project, { kind: 'path', path: local }), /symbolic|symlink/i);
});
test('malformed metadata and large documents cannot be previewed', async (t) => {
    const { service, project } = await setup(t);
    for (const bytes of [Buffer.from('no metadata'), Buffer.from('---\nname: ../escape\ndescription: x\n---\nx'), Buffer.alloc(256 * 1024 + 1)]) {
        await assert.rejects(service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes }));
    }
});
test('concurrent services preserve independent project updates', async (t) => {
    const { service, project, dataDir, dir } = await setup(t);
    const other = join(dir, 'other');
    await mkdir(other);
    const second = new SkillService({ dataDir, homeDir: join(dir, 'home') });
    const previews = await Promise.all([service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body('a') }), second.prepare(other, { kind: 'upload', filename: 'SKILL.md', bytes: body('b') })]);
    await Promise.all([service.confirm(previews[0].id), second.confirm(previews[1].id)]);
    assert.equal((await service.snapshot(project)).skills.length, 1);
    assert.equal((await second.snapshot(other)).skills.length, 1);
});
test('stale replacement cannot overwrite a later confirmed version', async (t) => {
    const { service, project } = await setup(t);
    const a = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body('a') });
    const b = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body('b') });
    await service.confirm(a.id);
    await assert.rejects(service.confirm(b.id), /changed|prepare.*again/i);
    assert.equal((await service.snapshot(project)).skills[0].version, a.skill.version);
});
test('invalid preview and skill ids fail with ordinary not-found errors', async (t) => {
    const { service, project } = await setup(t);
    await assert.rejects(service.confirm('__proto__'), (error: any) => error.status === 404);
    await assert.rejects(service.patch('__proto__', { project, enabled: true }), (error: any) => error.status === 404);
});
test('separate Node processes publish without losing either project binding', async (t) => {
    const { service, project, dataDir, dir } = await setup(t);
    const other = join(dir, 'other');
    await mkdir(other);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const moduleUrl = new URL('../src/skills/service.ts', import.meta.url).href;
    const script = `import {SkillService} from ${JSON.stringify(moduleUrl)};const [dataDir,project,homeDir,text]=process.argv.slice(1);const service=new SkillService({dataDir,homeDir});const preview=await service.prepare(project,{kind:'upload',filename:'SKILL.md',bytes:Buffer.from('---\\nname: example\\ndescription: Example\\n---\\n'+text)});await service.confirm(preview.id);`;
    await Promise.all([project, other].map((path, i) => run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, dataDir, path, join(dir, 'home'), String(i)])));
    assert.equal((await service.snapshot(project)).skills.length, 1);
    assert.equal((await service.snapshot(other)).skills.length, 1);
    assert.notEqual((await service.snapshot(project)).skills[0].version, (await service.snapshot(other)).skills[0].version);
});
test('tampered preview bytes cannot be published', async (t) => {
    const { service, project, dataDir } = await setup(t);
    const preview = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const { chmod } = await import('node:fs/promises');
    const path = join(dataDir, 'skills', 'previews', preview.id, 'SKILL.md');
    await chmod(path, 0o600);
    await writeFile(path, body('changed'));
    await assert.rejects(service.confirm(preview.id), /content changed/);
    assert.equal((await service.snapshot(project)).skills.length, 0);
});
test('preparing a new preview removes expired staged bytes while expiry remains actionable',async t=>{
 let now=Date.now();const {service,project,dataDir}=await setup(t,()=>now);
 const expired=await service.prepare(project,{kind:'upload',filename:'SKILL.md',bytes:body()});now+=15*60*1000;
 await service.prepare(project,{kind:'upload',filename:'SKILL.md',bytes:body('new')});
 await assert.rejects(readFile(join(dataDir,'skills','previews',expired.id,'SKILL.md')),(error:any)=>error.code==='ENOENT');
 await assert.rejects(service.confirm(expired.id),(error:any)=>error.status===410);
});
test('an unconfirmed same-content preview cannot re-enable a subsequently disabled skill', async t => {
    const { service, project } = await setup(t);
    const a = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const b = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const confirmed = await service.confirm(a.id);
    const disabled = await service.patch(a.skill.id, { project, enabled: false });
    await assert.rejects(service.confirm(b.id), (error: any) => error.status === 409);
    assert.deepEqual(await service.snapshot(project), disabled);
    assert.deepEqual(await service.confirm(a.id), confirmed);
    assert.deepEqual(await service.snapshot(project), disabled);
});
test('same-content confirmation without a binding mutation remains safe', async t => {
    const { service, project } = await setup(t);
    const a = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const b = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const confirmed = await service.confirm(a.id);
    assert.deepEqual((await service.confirm(b.id)).snapshot, confirmed.snapshot);
});
test('inherited and malformed version keys cannot mutate persisted bindings or revision', async t => {
    const { service, project, dataDir } = await setup(t);
    const preview = await service.prepare(project, { kind: 'upload', filename: 'SKILL.md', bytes: body() });
    const confirmed = await service.confirm(preview.id);
    const before = await readFile(join(dataDir, 'skills', 'state.json'), 'utf8');
    for (const version of ['constructor', '__proto__', 'toString', '', 'x'.repeat(64), 'a'.repeat(64)]) {
        await assert.rejects(service.patch(preview.skill.id, { project, enabled: true, version }), (error: any) => error.status === 404);
        assert.equal(await readFile(join(dataDir, 'skills', 'state.json'), 'utf8'), before);
        assert.deepEqual(await service.snapshot(project), confirmed.snapshot);
    }
});
