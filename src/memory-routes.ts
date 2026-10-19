import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolveProjectForHistory } from "./project-resolver.js";
import { getMemoryService, MemoryError } from "./memory/service.js";
import type { FeedbackInput, MemoryService, ReviewInput } from "./memory/types.js";

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new MemoryError("请提供有效的 JSON 请求", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MemoryError("请提供 JSON 对象", 400);
  return value as Record<string, unknown>;
}

/** Mounted after the server's existing Bearer middleware. */
export function createMemoryRoutes(injected?: MemoryService) {
  const app = new Hono();
  const service = () => {
    const result = injected ?? getMemoryService();
    if (!result) throw new MemoryError("记忆功能未启用或当前 Node 不支持；请使用 Node 22.13 及以上版本。", 503);
    return result;
  };
  app.use("*", bodyLimit({ maxSize: 512 * 1024, onError: c => c.json({ error: "知识请求不能超过 512 KiB" }, 413) }));
  app.onError((error, c) => {
    const status = error instanceof MemoryError ? error.status : 500;
    return c.json({ error: error instanceof MemoryError ? error.message : "知识操作失败，请稍后重试" }, status as ContentfulStatusCode);
  });
  app.get("/knowledge", async c => {
    const project = c.req.query("project")?.trim();
    if (!project) throw new MemoryError("请指定项目", 400);
    let path: string;
    try { path = resolveProjectForHistory(project); }
    catch (error) { throw new MemoryError(error instanceof Error ? error.message : "项目无效", 400); }
    const integer = (name: string, fallback: number, max: number) => {
      const value = c.req.query(name);
      if (value === undefined) return fallback;
      if (!/^\d+$/.test(value) || Number(value) > max) throw new MemoryError(`${name} 无效`, 400);
      return Number(value);
    };
    return c.json(await service().list(path, { state: c.req.query("state"), limit: integer("limit", 50, 100), offset: integer("offset", 0, 1_000_000) }));
  });
  app.get("/knowledge/:id", async c => c.json(await service().getKnowledge(c.req.param("id"))));
  app.get("/answers/:id/feedback", async c => c.json(await service().getFeedback(c.req.param("id"), c.req.query("clientId") ?? "")));
  app.post("/knowledge/:id/evidence", async c => {
    const body = await jsonBody(c.req.raw);
    if (!Number.isSafeInteger(body.expectedRevision) || typeof body.expectedSourceKey !== "string" || !Array.isArray(body.evidence)) throw new MemoryError("源码核验参数无效", 400);
    return c.json(await service().previewEvidence(c.req.param("id"), body as unknown as Parameters<MemoryService["previewEvidence"]>[1]));
  });
  app.post("/knowledge", async c => {
    const body = await jsonBody(c.req.raw);
    if (typeof body.answerId !== "string" || !body.answerId) throw new MemoryError("请指定后端答案 ID", 400);
    return c.json(await service().createCandidate(body.answerId));
  });
  app.put("/answers/:id/feedback", async c => {
    const body = await jsonBody(c.req.raw);
    if (typeof body.clientId !== "string" || !["up", "down", null].includes(body.vote as string | null)) throw new MemoryError("反馈参数无效", 400);
    if (body.reason !== undefined && !["incorrect", "outdated", "irrelevant", "presentation"].includes(body.reason as string)) throw new MemoryError("反馈原因无效", 400);
    if (body.comment !== undefined && typeof body.comment !== "string") throw new MemoryError("反馈说明无效", 400);
    return c.json(await service().feedback(c.req.param("id"), body as unknown as FeedbackInput));
  });
  app.post("/knowledge/:id/review", async c => {
    const body = await jsonBody(c.req.raw);
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1 ||
      !["publish", "revise", "suspend", "withdraw"].includes(body.action as string)) throw new MemoryError("审核参数无效，请刷新后重试", 400);
    for (const field of ["question", "answer", "conditions"]) {
      if (body[field] !== undefined && typeof body[field] !== "string") throw new MemoryError(`审核字段 ${field} 无效`, 400);
    }
    if (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some(item => !item || typeof item !== "object" || typeof item.path !== "string" || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)))) throw new MemoryError("源码证据无效", 400);
    if (body.expectedSourceKey !== undefined && typeof body.expectedSourceKey !== "string" || body.revalidate !== undefined && typeof body.revalidate !== "boolean") throw new MemoryError("源码核验参数无效", 400);
    return c.json(await service().review(c.req.param("id"), body as unknown as ReviewInput));
  });
  return app;
}
