import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { serve } from "@hono/node-server";
import { createReadOnlySession } from "./session-factory.js";
import { resolveProject, resolveProjectForHistory } from "./project-resolver.js";
import {
  closeSession,
  getSession,
  getHistoryActiveSessionId,
  isHistoryActive,
  listSessions,
  openSession,
  runOnSession,
} from "./session-registry.js";
import { listModels } from "./models.js";
import { runAsk, type AskEvent } from "./ask.js";
import { createSkillRoutes } from "./skill-routes.js";
import { createMemoryRoutes } from "./memory-routes.js";
import type { AskOptions } from "./ask.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SessionQueue } from "./session-queue.js";
import { LlmConfigError, parseModelOptions } from "./llm-config.js";
import { HistoryError, listProjectHistory, validateHistorySelection } from "./session-history.js";

// ---------------- 参数解析 ----------------
interface ServerArgs {
  port: number;
  host: string;
  token: string;
}

function parseArgs(argv: string[]): ServerArgs {
  const out: ServerArgs = { port: 8787, host: "127.0.0.1", token: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a.startsWith("--token=")) out.token = a.slice("--token=".length);
    else if (a === "--help" || a === "-h") {
      console.log(`
code-analyzer HTTP 服务

用法:
  npm run serve -- [--port 8787] [--host 127.0.0.1] [--token <key>]

参数:
  --port  监听端口（默认 8787）
  --host  绑定地址（默认 127.0.0.1；暴露局域网用 0.0.0.0）
  --token 鉴权 token；不提供则自动生成一个并打印
`);
      process.exit(0);
    }
  }
  return out;
}

// ---------------- SSE 写入器（保序 + 容错） ----------------
function makeSseWriter(stream: SSEStreamingApi) {
  let chain: Promise<void> = Promise.resolve();
  const write = (event: string, data: unknown): Promise<void> => {
    chain = chain
      .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
      .catch(() => {}); // 客户端断开后忽略后续写入
    return chain;
  };
  return write;
}

function sseHandler(write: (e: string, d: unknown) => Promise<void>) {
  return (e: AskEvent) => {
    if (e.type === "answer_reused") { void write("text", { delta: e.answer }); return; }
    if (e.type === "skill_preview") { void write("skill_preview", e.preview); return; }
    if (e.type === "skills_applied") { void write("skills_applied", e.snapshot); return; }
    if (e.type === "message_update") {
      const ev = e.assistantMessageEvent;
      if (ev.type === "text_delta") void write("text", { delta: ev.delta });
      else if (ev.type === "thinking_delta") void write("thinking", { delta: ev.delta });
      return;
    }
    if (e.type === "tool_execution_start") {
      void write("tool", { name: e.toolName, args: e.args, phase: "start" });
      return;
    }
    if (e.type === "tool_execution_end") {
      void write("tool", { name: e.toolName, phase: "end", isError: e.isError });
    }
  };
}

function askOptions(body: { requestId?: unknown; reuse?: unknown }): AskOptions {
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 200)) throw new Error("requestId 必须是 1 到 200 字符");
  if (body.reuse !== undefined && body.reuse !== "auto" && body.reuse !== "bypass") throw new Error("reuse 必须是 auto 或 bypass");
  return { requestId: body.requestId as string | undefined, reuse: body.reuse as AskOptions["reuse"] };
}
function askFailure(error: unknown) {
  const known = error as { status?: number; code?: string; newSessionRequired?: boolean } | undefined;
  return { message: error instanceof Error ? error.message : String(error),
    ...(known?.code ? { code: known.code } : {}), ...(known?.newSessionRequired ? { newSessionRequired: true } : {}) };
}
function askStatus(error: unknown): ContentfulStatusCode {
  const status = (error as { status?: number } | undefined)?.status;
  return ([400, 404, 409, 503].includes(status ?? 0) ? status : 500) as ContentfulStatusCode;
}

// ---------------- App ----------------
export function createApp(token: string) {
  const app = new Hono();

  app.use("*", cors());

  // 鉴权：除 /health 与 OPTIONS 外，均需 Bearer token
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health") return next();
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/skills", createSkillRoutes());
  app.route("/memory", createMemoryRoutes());

  // 列出可用模型（需鉴权）
  app.get("/models", async (c) => {
    try {
      return c.json(await listModels());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/history", async (c) => {
    const project = c.req.query("project")?.trim();
    if (!project) return c.json({ error: "missing 'project'" }, 400);
    let projectPath: string;
    try {
      projectPath = resolveProjectForHistory(project);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    try {
      const sessions = (await listProjectHistory(projectPath)).map((session) => ({
        ...session, active: isHistoryActive(projectPath, session.id),
        activeSessionId: getHistoryActiveSessionId(projectPath, session.id),
      }));
      return c.json({ projectPath, sessions });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // 建/恢复会话
  app.post("/sessions", async (c) => {
    let body: { project?: string; sessionId?: string; resume?: boolean; modelId?: string; historyId?: string };
    let modelOptions: ReturnType<typeof parseModelOptions>;
    try {
      body = await c.req.json();
      modelOptions = parseModelOptions(body);
      validateHistorySelection(body);
      if (body.resume !== undefined && typeof body.resume !== "boolean") return c.json({ error: "resume must be boolean" }, 400);
    } catch (e) {
      if (e instanceof LlmConfigError || e instanceof HistoryError) return c.json({ error: e.message }, 400);
      return c.json({ error: "invalid json body" }, 400);
    }
    if (typeof body.project !== "string" || !body.project.trim()) return c.json({ error: "missing 'project'" }, 400);
    try {
      const r = await openSession({
        project: body.project,
        sessionId: body.sessionId,
        resume: body.resume,
        historyId: body.historyId,
        ...modelOptions,
      });
      return c.json(r);
    } catch (e) {
      if (e instanceof HistoryError) return c.json({ error: e.message }, e.status);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/sessions", (c) => c.json({ sessions: listSessions() }));

  // 提问（默认 SSE 流式；?stream=false 返回 JSON）
  app.post("/sessions/:id/ask", async (c) => {
    const entry = getSession(c.req.param("id"));
    if (!entry) return c.json({ error: "session not found" }, 404);

    let body: { question?: string; requestId?: string; reuse?: "auto" | "bypass" };
    let options: AskOptions;
    try {
      body = await c.req.json();
      options = askOptions(body);
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    if (typeof body.question !== "string" || !body.question.trim()) return c.json({ error: "missing 'question'" }, 400);

    const wantStream = c.req.query("stream") !== "false";

    if (!wantStream) {
      try {
        const outcome = await runOnSession(
          entry,
          (signal) => runAsk(entry.session, body.question!, undefined, signal, options),
          c.req.raw.signal,
        );
        return c.json({
          answer: outcome.answer,
          modelLabel: entry.modelLabel,
          toolCalls: outcome.toolCalls,
          skillPreviews: outcome.skillPreviews,
          ...outcome.metadata,
        });
      } catch (e) {
        return c.json({ error: askFailure(e).message, ...askFailure(e) }, askStatus(e));
      }
    }

    return streamSSE(c, async (stream) => {
      const write = makeSseWriter(stream);
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      if (stream.aborted) controller.abort();
      try {
        const outcome = await runOnSession(
          entry,
          (signal) => runAsk(entry.session, body.question!, sseHandler(write), signal, options),
          controller.signal,
        );
        await write("done", { modelLabel: entry.modelLabel, answer: outcome.answer, ...outcome.metadata });
      } catch (e) {
        await write("error", askFailure(e));
      }
    });
  });

  app.delete("/sessions/:id", async (c) => {
    const ok = await closeSession(c.req.param("id"));
    return c.json({ ok });
  });

  // 一次性提问（无会话，JSON；?stream=true 可流式）
  app.post("/ask", async (c) => {
    let body: { project?: string; question?: string; modelId?: string; requestId?: string; reuse?: "auto" | "bypass" };
    let modelOptions: ReturnType<typeof parseModelOptions>;
    let options: AskOptions;
    try {
      body = await c.req.json();
      options = askOptions(body);
      modelOptions = parseModelOptions(body);
    } catch (e) {
      if (e instanceof LlmConfigError) return c.json({ error: e.message }, 400);
      return c.json({ error: "invalid json body" }, 400);
    }
    if (typeof body.project !== "string" || !body.project.trim() || typeof body.question !== "string" || !body.question.trim()) {
      return c.json({ error: "missing 'project' or 'question'" }, 400);
    }

    let resolved;
    try {
      resolved = resolveProject(body.project);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const wantStream = c.req.query("stream") === "true";

    let created;
    try {
      created = await createReadOnlySession(resolved.cwd, {
        resume: false,
        inMemory: true,
        ...modelOptions,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    const { session, modelLabel } = created;
    const queue = new SessionQueue(session);

    if (wantStream) {
      return streamSSE(c, async (stream) => {
        const write = makeSseWriter(stream);
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        if (stream.aborted) controller.abort();
        try {
          const outcome = await queue.run(
            (signal) => runAsk(session, body.question!, sseHandler(write), signal, options),
            controller.signal,
          );
          await write("done", { modelLabel, answer: outcome.answer, ...outcome.metadata });
        } catch (e) {
          await write("error", askFailure(e));
        } finally {
          await queue.close();
        }
      });
    }

    try {
      const outcome = await queue.run(
        (signal) => runAsk(session, body.question!, undefined, signal, options),
        c.req.raw.signal,
      );
      return c.json({ answer: outcome.answer, modelLabel, toolCalls: outcome.toolCalls, skillPreviews: outcome.skillPreviews, ...outcome.metadata });
    } catch (e) {
      return c.json({ error: askFailure(e).message, ...askFailure(e) }, askStatus(e));
    } finally {
      await queue.close();
    }
  });

  return app;
}

// ---------------- 启动 ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token || randomBytes(24).toString("hex");
  const app = createApp(token);
  const server = serve({ fetch: app.fetch, port: args.port, hostname: args.host }, (info) => {
    console.log("=".repeat(56));
    console.log("code-analyzer HTTP 服务已启动");
    console.log(`  监听: http://${args.host}:${info.port}`);
    console.log(`  Token: ${token}`);
    console.log(`  鉴权: Authorization: Bearer <token>`);
    console.log("=".repeat(56));
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`启动失败：${args.host}:${args.port} 已被占用。请使用现有服务，或通过 --port 指定其他端口。`);
    } else {
      console.error(`HTTP 服务错误：${error.message}`);
    }
    process.exitCode = 1;
  });
}
