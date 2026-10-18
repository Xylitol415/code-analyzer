import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createReadOnlySession } from "./session-factory.js";
import { resolveProject } from "./project-resolver.js";
import {
  closeSession,
  getSession,
  listSessions,
  openSession,
  runOnSession,
  type SessionEntry,
} from "./session-registry.js";
import { listModels } from "./models.js";

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

// ---------------- 提问执行 ----------------
interface AskOutcome {
  answer: string;
  toolCalls: Array<{ name: string; args: unknown; isError: boolean; ms: number }>;
}

async function runAsk(
  session: AgentSession,
  question: string,
  onEvent?: (e: AgentSessionEvent) => void,
): Promise<AskOutcome> {
  let answer = "";
  const toolCalls: AskOutcome["toolCalls"] = [];
  const startInfo = new Map<string, { start: number; args: unknown }>();

  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") answer += ev.delta;
    } else if (event.type === "tool_execution_start") {
      startInfo.set(event.toolCallId, { start: Date.now(), args: event.args });
    } else if (event.type === "tool_execution_end") {
      const info = startInfo.get(event.toolCallId);
      toolCalls.push({
        name: event.toolName,
        args: info?.args,
        isError: event.isError,
        ms: info ? Date.now() - info.start : 0,
      });
    }
    onEvent?.(event);
  });

  try {
    await session.prompt(question);
  } finally {
    unsub();
  }
  return { answer, toolCalls };
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

function sseHandler(entry: SessionEntry, question: string, write: (e: string, d: unknown) => Promise<void>) {
  return (e: AgentSessionEvent) => {
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

// ---------------- App ----------------
const args = parseArgs(process.argv.slice(2));
const token = args.token || randomBytes(24).toString("hex");

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

// 列出可用模型（需鉴权）
app.get("/models", async (c) => {
  try {
    return c.json(await listModels());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// 建/恢复会话
app.post("/sessions", async (c) => {
  let body: { project?: string; sessionId?: string; resume?: boolean; modelId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  if (!body.project) return c.json({ error: "missing 'project'" }, 400);
  try {
    const r = await openSession({
      project: body.project,
      sessionId: body.sessionId,
      resume: body.resume,
      modelId: body.modelId,
    });
    return c.json(r);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/sessions", (c) => c.json({ sessions: listSessions() }));

// 提问（默认 SSE 流式；?stream=false 返回 JSON）
app.post("/sessions/:id/ask", async (c) => {
  const entry = getSession(c.req.param("id"));
  if (!entry) return c.json({ error: "session not found" }, 404);

  let body: { question?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  if (!body.question) return c.json({ error: "missing 'question'" }, 400);

  const wantStream = c.req.query("stream") !== "false";

  if (!wantStream) {
    try {
      const outcome = await runOnSession(entry, () => runAsk(entry.session, body.question!));
      return c.json({
        answer: outcome.answer,
        modelLabel: entry.modelLabel,
        toolCalls: outcome.toolCalls,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return streamSSE(c, async (stream) => {
    const write = makeSseWriter(stream);
    stream.onAbort(() => {
      entry.session.abort().catch(() => {});
    });
    try {
      const outcome = await runOnSession(entry, () =>
        runAsk(entry.session, body.question!, sseHandler(entry, body.question!, write)),
      );
      await write("done", { modelLabel: entry.modelLabel, answer: outcome.answer });
    } catch (e) {
      await write("error", { message: e instanceof Error ? e.message : String(e) });
    }
  });
});

app.delete("/sessions/:id", (c) => {
  const ok = closeSession(c.req.param("id"));
  return c.json({ ok });
});

// 一次性提问（无会话，JSON；?stream=true 可流式）
app.post("/ask", async (c) => {
  let body: { project?: string; question?: string; modelId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  if (!body.project || !body.question) {
    return c.json({ error: "missing 'project' or 'question'" }, 400);
  }

  let resolved;
  try {
    resolved = resolveProject(body.project);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  const wantStream = c.req.query("stream") === "true";

  if (wantStream) {
    const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
      resume: false,
      inMemory: true,
      modelId: body.modelId,
    });
    return streamSSE(c, async (stream) => {
      const write = makeSseWriter(stream);
      stream.onAbort(() => session.abort().catch(() => {}));
      try {
        const outcome = await runAsk(session, body.question!, sseHandler(
          { session, modelLabel, projectPath: resolved.cwd, id: "one-shot", queue: Promise.resolve() },
          body.question!,
          write,
        ));
        await write("done", { modelLabel, answer: outcome.answer });
      } catch (e) {
        await write("error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        session.dispose();
      }
    });
  }

  const { session, modelLabel } = await createReadOnlySession(resolved.cwd, {
    resume: false,
    inMemory: true,
    modelId: body.modelId,
  });
  try {
    const outcome = await runAsk(session, body.question!);
    return c.json({ answer: outcome.answer, modelLabel, toolCalls: outcome.toolCalls });
  } finally {
    session.dispose();
  }
});

// ---------------- 启动 ----------------
console.log("=".repeat(56));
console.log("code-analyzer HTTP 服务已启动");
console.log(`  监听: http://${args.host}:${args.port}`);
console.log(`  Token: ${token}`);
console.log(`  鉴权: Authorization: Bearer <token>`);
console.log("=".repeat(56));

serve({ fetch: app.fetch, port: args.port, hostname: args.host });
