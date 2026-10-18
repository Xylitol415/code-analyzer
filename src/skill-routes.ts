import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolveProjectForHistory } from "./project-resolver.js";
import { getSkillService, type SkillService } from "./skills/service.js";
import { SkillError, type SkillImportInput } from "./skills/types.js";

const UPLOAD_LIMIT = 20 * 1024 * 1024;

async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new SkillError("上传内容超过大小限制", 413);
  if (!request.body) throw new SkillError("请求内容不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SkillError("上传内容超过大小限制", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function projectPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new SkillError("请指定项目路径或已缓存的 Git URL");
  try { return resolveProjectForHistory(input.trim()); }
  catch (error) { throw new SkillError(error instanceof Error ? error.message : "项目路径无效"); }
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024 * 1024)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError("请提供有效的 JSON 请求");
  }
}

/** Mounted after the application's Bearer middleware. Never accepts arbitrary local paths. */
export function createSkillRoutes(service?: SkillService) {
  const app = new Hono();
  const skills = () => service ?? getSkillService();
  app.onError((error, c) => c.json(
    { error: error instanceof SkillError ? error.message : "技能操作失败，请稍后重试" },
    (error instanceof SkillError ? error.status : 500) as ContentfulStatusCode,
  ));

  app.get("/", async (c) => c.json(await skills().list(projectPath(c.req.query("project")))));
  app.post("/imports", async (c) => {
    let project: string;
    let input: SkillImportInput;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const bytes = await boundedBody(c.req.raw, UPLOAD_LIMIT + 64 * 1024);
      let form: FormData;
      try { form = await new Response(bytes, { headers: { "content-type": contentType } }).formData(); }
      catch { throw new SkillError("上传表单无效，请重新选择 SKILL.md 或 ZIP 文件"); }
      project = projectPath(form.get("project"));
      const files = form.getAll("file");
      const file = files[0];
      if (files.length !== 1 || !file || typeof file === "string") throw new SkillError("每次请选择一个 SKILL.md 或 ZIP 文件");
      if (file.size > UPLOAD_LIMIT) throw new SkillError("文件不能超过 20 MiB", 413);
      input = { kind: "upload", filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } else {
      const body = await jsonBody(c.req.raw);
      project = projectPath(body.project);
      if (typeof body.url === "string" && body.localId === undefined && body.path === undefined) input = { kind: "url", url: body.url };
      else if (typeof body.localId === "string" && body.url === undefined && body.path === undefined) input = { kind: "local", localId: body.localId };
      else throw new SkillError("请提供公开 HTTPS URL 或从本机技能列表选择导入");
    }
    return c.json(await skills().prepare(project, input));
  });
  app.post("/imports/:id/confirm", async (c) => c.json(await skills().confirm(c.req.param("id"))));
  app.patch("/:id", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (typeof body.enabled !== "boolean" || (body.version !== undefined && typeof body.version !== "string")) throw new SkillError("请指定 enabled 和有效的版本");
    return c.json(await skills().patch(c.req.param("id"), { project: projectPath(body.project), enabled: body.enabled, version: body.version as string | undefined }));
  });
  return app;
}
