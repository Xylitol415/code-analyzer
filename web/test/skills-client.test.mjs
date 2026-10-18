import assert from "node:assert/strict";
import { test } from "node:test";
import { listSkills, prepareSkillImport, confirmSkillImport, patchSkill } from "../src/api/client.ts";

const config = { baseUrl: "http://backend.test", token: "backend-secret" };

test("skill imports upload bytes with a browser multipart boundary and separate explicit confirmation", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { requests.push({ url, ...options }); return Response.json({ id: "preview" }); });
  const file = new File(["---\nname: review\n---\nReview code"], "SKILL.md", { type: "text/markdown" });
  await prepareSkillImport(config, "/project a", { file });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://backend.test/skills/imports");
  assert.equal(requests[0].headers.Authorization, "Bearer backend-secret");
  assert.equal(requests[0].headers["Content-Type"], undefined);
  assert.equal(requests[0].body.get("project"), "/project a");
  assert.equal(await requests[0].body.get("file").text(), await file.text());
  await confirmSkillImport(config, "preview/a");
  assert.equal(requests[1].url, "http://backend.test/skills/imports/preview%2Fa/confirm");
  assert.deepEqual(JSON.parse(requests[1].body), {});
});

test("skill library, URL/local imports and version updates use project-scoped authenticated endpoints", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { requests.push({ url, ...options }); return Response.json({}); });
  await listSkills(config, "/project a");
  await prepareSkillImport(config, "/project a", { url: "https://public.test/SKILL.md" });
  await prepareSkillImport(config, "/project a", { localId: "local-hash" });
  await patchSkill(config, "/project a", "skill/id", true, "version-hash");
  assert.equal(requests[0].url, "http://backend.test/skills?project=%2Fproject%20a");
  assert.deepEqual(JSON.parse(requests[1].body), { project: "/project a", url: "https://public.test/SKILL.md" });
  assert.deepEqual(JSON.parse(requests[2].body), { project: "/project a", localId: "local-hash" });
  assert.equal(requests[3].url, "http://backend.test/skills/skill%2Fid");
  assert.equal(requests[3].method, "PATCH");
  assert.deepEqual(JSON.parse(requests[3].body), { project: "/project a", enabled: true, version: "version-hash" });
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer backend-secret"));
});

test("all skill operations surface server validation and backend token errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Preview expired" }, { status: 410 }));
  await assert.rejects(() => confirmSkillImport(config, "old"), /Preview expired/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  for (const operation of [() => listSkills(config, "/project"), () => prepareSkillImport(config, "/project", { localId: "id" }), () => patchSkill(config, "/project", "id", false)]) {
    await assert.rejects(operation, /401.*Token/);
  }
});
