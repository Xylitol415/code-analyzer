# code-analyzer

只读的代码逻辑分析助手：给定一个 git 项目路径（本地路径或远程 URL），即可交互式地分析代码逻辑。基于 [pi SDK](https://pi.dev/docs/latest/sdk) 构建。

## 快速开始

### 1. 环境要求

- Node.js ≥ 20
- Git（分析远程仓库时需要）
- 一个可用的模型凭据（默认复用本机 pi 配置，或用 `.env`/环境变量，见「配置」一节）

### 2. 安装依赖

```bash
cd code-analyzer
npm install
```

### 3. 配置 API Key（三选一）

```bash
# 方式 A：复用本机 pi 全局配置（~/.pi/agent），零配置

# 方式 B：.env 文件（推荐）
cp .env.example .env        # 然后编辑，填入 CODE_ANALYZER_API_KEY

# 方式 C：系统环境变量
export CODE_ANALYZER_API_KEY=sk-xxx
```

### 4. 启动（三种使用方式任选）

| 方式 | 命令 | 适用场景 |
|------|------|----------|
| 终端 REPL | `npm start -- <项目路径或URL>` | 命令行里交互式分析 |
| HTTP 服务 | `npm run serve -- --port 8787 --token xxx` | 供 API / 脚本 / 前端调用 |
| Web 网页 | 后端 `npm run serve` + 前端 `cd web && npm run dev` | 浏览器聊天界面 |

```bash
# 方式一：终端 REPL
npm start -- /path/to/your/repo

# 方式二：HTTP 服务
npm run serve -- --port 8787 --token my-secret-key

# 方式三：Web 网页（两个终端）
npm run serve -- --port 8787 --token my-secret-key   # 终端 1：后端
cd web && npm install && npm run dev                 # 终端 2：前端，打开 http://127.0.0.1:5173
```

各方式的详细参数与说明见下文各节。

## 主要功能

**核心能力**

- **严格只读的代码分析**：只暴露 `read / grep / find / ls` + 一个自定义只读 `git` 工具（白名单子命令），**不含** `bash / edit / write`。只读是结构性保证，不是提示词约束。
- **交互式多轮问答**：流式输出，可无限追问；会话按项目路径持久化，下次进入同一项目自动恢复上下文。
- **过程可视化**：实时展示模型的思考过程（reasoning）与工具调用（工具名、参数、耗时、结果预览）。
- **本地路径 + 远程 URL 都支持**：URL 自动浅克隆到 `~/.code-analyzer/repos/<hash>`，已克隆则复用。
- **可配置的模型与凭据**：通过 `.env` / 环境变量覆盖 API key、模型、base URL，或复用本机 pi 配置。

**三种使用形态**

| 形态 | 说明 |
|------|------|
| 终端 REPL | 命令行交互式分析，零依赖快速上手 |
| HTTP 服务 | SSE 流式 + JSON，供 API / 脚本 / 前端调用 |
| Web 网页 | React 聊天界面，浏览器里可视化提问 |

## 用法

```bash
# 本地路径
npm start -- ./my-repo

# 远程 URL（自动 clone）
npm start -- https://github.com/user/repo.git

# 强制开全新会话（默认恢复上次会话）
npm start -- ./my-repo --new

# 覆盖默认模型
npm start -- ./my-repo --model deepseek/deepseek-v4-pro

# 隐藏思考过程（reasoning 可能较长）
npm start -- ./my-repo --no-thinking

# 关闭彩色输出（适合脚本/管道）
npm start -- ./my-repo --no-color
```

> 输出里 `[思考]` 开头的是模型的推理过程（暗色），`⚙ 工具名` / `✓ · 耗时 → 结果预览` 是工具调用过程；正常回答为普通文本。

进入后直接提问，例如：

- 「这个项目的整体架构是什么？」
- 「登录鉴权的逻辑在哪，调用链怎么串的？」
- 「`src/auth.ts` 里这个函数做了什么？」

输入 `exit` / `quit` 或按 `Ctrl+D` 退出；`Ctrl+C` 中止当前回答。

### 参数一览

| 参数 | 作用 |
|------|------|
| `<路径或 URL>` | 本地 git 仓库路径，或远程 git URL |
| `--new` | 开全新会话（默认恢复上次会话） |
| `--model provider/id` | 指定模型 |
| `--no-thinking` | 隐藏思考过程 |
| `--no-color` | 关闭彩色输出 |
| `--help` | 帮助 |

## 配置（API Key 与模型）

默认复用本机 pi 的全局配置（`~/.pi/agent/auth.json` + `models-store.json`）。也可改用**环境变量**或项目根目录的 **`.env` 文件**覆盖：

| 环境变量 | 作用 | 示例 |
|----------|------|------|
| `CODE_ANALYZER_API_KEY` | API key（应用于所选模型的 provider） | `sk-...` |
| `CODE_ANALYZER_MODEL` | 模型选择（`provider/modelId` 或 `modelId`） | `deepseek/deepseek-v4-pro` |
| `CODE_ANALYZER_BASE_URL` | （可选）覆盖 API base URL | `https://api.deepseek.com` |

优先级：**命令行 `--model` / HTTP `modelId` > 系统环境变量 > `.env` 文件 > 全局 `~/.pi/agent` 配置**。

```bash
# 方式一：.env 文件（推荐）
cp .env.example .env   # 然后编辑 .env 填入真实值

# 方式二：系统环境变量
export CODE_ANALYZER_API_KEY=sk-xxx
export CODE_ANALYZER_MODEL=deepseek/deepseek-v4-pro
export CODE_ANALYZER_BASE_URL=https://api.deepseek.com  # 可选
```

> **安全**：`.env` 已被 `.gitignore` 忽略（`.env`、`.env.*` 均不上传，仅 `.env.example` 模板会提交）。上传 GitHub 前 `.env` 里的真实 key 永远不会被 git 跟踪。

## HTTP 服务

除交互式 REPL 外，也提供 HTTP 接口：启动后通过 API 提问（支持 SSE 流式与 JSON 一次性）。

```bash
npm run serve -- --port 8787 --token my-secret-key
```

启动参数：`--port`（默认 8787）、`--host`（默认 127.0.0.1，暴露局域网用 0.0.0.0）、`--token`（不提供则自动生成并打印）。除 `/health` 外，所有请求需带 `Authorization: Bearer <token>`。

### 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（免鉴权） |
| POST | `/sessions` | 建会话，body `{project, resume?, modelId?, sessionId?}` → `{id, projectPath, modelLabel}` |
| GET | `/sessions` | 列出活动会话 |
| POST | `/sessions/:id/ask` | 提问，body `{question}`；默认 SSE 流式，`?stream=false` 返回 JSON |
| DELETE | `/sessions/:id` | 释放会话 |
| POST | `/ask` | 一次性提问，body `{project, question, modelId?}`；默认 JSON，`?stream=true` 流式 |

### curl 示例

```bash
TOKEN=my-secret-key
BASE=http://127.0.0.1:8787

# 一次性提问（JSON）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo","question":"这个项目做什么？"}' "$BASE/ask"

# 建会话（多轮）
SID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo"}' "$BASE/sessions" | jq -r .id)

# 会话内提问（SSE 流式）
curl -N -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"登录鉴权逻辑在哪？"}' "$BASE/sessions/$SID/ask"

# 会话内提问（JSON）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"继续：调用链怎么串？"}' "$BASE/sessions/$SID/ask?stream=false"
```

### SSE 事件

| 事件 | data |
|------|------|
| `thinking` | `{"delta":"..."}` 推理增量 |
| `tool` | `{"name":"read","args":{...},"phase":"start"}` 或 `{"name":"read","phase":"end","isError":false}` |
| `text` | `{"delta":"..."}` 回答增量 |
| `done` | `{"modelLabel":"...","answer":"完整回答"}` |
| `error` | `{"message":"..."}` |

> 同一会话的请求会**串行排队**（pi 的单会话模型同一时刻只允许一个 prompt）；不同会话之间并行。客户端断开 SSE 连接会触发当前回答中止。

## Web 前端

一个单页聊天前端（`web/` 目录），通过 SSE 实时消费上面的 HTTP 接口。

技术栈：Vite + React 19 + TypeScript + Ant Design 6 + Tailwind CSS v4（关闭 preflight 避免重置 AntD 样式）+ react-markdown（代码高亮）+ @microsoft/fetch-event-source（POST + SSE）。

### 启动

```bash
# 1. 先起后端（记住 token）
npm run serve -- --port 8787 --token my-secret-key

# 2. 再起前端
cd web && npm install && npm run dev
# 打开 http://127.0.0.1:5173
```

页面上填写「后端地址 + Token + 项目路径」→ 点「建会话」→ 即可在聊天框提问。

功能：流式回答（markdown 渲染）、思考过程/工具调用可折叠查看、多轮追问、新建会话、停止回答。

## 架构与设计

### 目录结构

```
code-analyzer/
├── src/                        # 后端（Node + TypeScript + pi SDK）
│   ├── main.ts                 # CLI 入口（参数解析）
│   ├── project-resolver.ts     # 识别本地路径 / 远程 URL，URL 自动 clone
│   ├── session-factory.ts      # 核心：创建只读会话 + 模型/key/baseURL 解析
│   ├── git-tool.ts             # 自定义只读 git 工具（白名单子命令）
│   ├── repl.ts                 # 终端 REPL（流式 + 思考/工具可视化）
│   ├── server.ts               # HTTP 服务（Hono，SSE + JSON，Bearer 鉴权）
│   ├── session-registry.ts     # 会话注册表 + 每会话串行队列
│   └── config.ts               # .env / 环境变量加载
└── web/                        # 前端（React + Ant Design + Tailwind）
    └── src/ ...
```

### 分层与复用

`session-factory.ts` 是三种形态共用的核心：负责创建只读会话（工具集、系统提示词、模型/凭据解析）。REPL、HTTP 服务、Web 前端都只是它的「前端」，各自负责与用户 / 客户端交互。

```
project-resolver（解析项目路径）
        ↓
session-factory（只读会话 + 模型/凭据 + 系统提示词）
        ↓
   ┌────┴──────┬──────────┐
  REPL        HTTP 服务    Web 前端
(repl.ts)   (server.ts)  (web/，走 HTTP SSE)
```

### 关键设计决策

1. **严格只读 = 结构性保证**：通过 `tools` 白名单只启用 `read/grep/find/ls` + 自定义只读 `git` 工具，模型拿不到任何写文件 / 执行任意命令的能力，而非依赖提示词约束。
2. **会话持久化**：用 pi SDK 的 `SessionManager` 按项目路径持久化会话，`resume` 时恢复上下文。
3. **模型显式解析**：`ModelRuntime.create()` + `getModel` / `getAvailable` 显式选模型，默认优先 `deepseek/deepseek-v4-pro`，避免配置里失效的 `defaultModel` 导致静默失败。
4. **配置优先级**：`--model` / HTTP `modelId` > 系统环境变量 > `.env` 文件 > 全局 `~/.pi/agent`。
5. **并发模型**：pi 的单会话同一时刻只允许一个 prompt，因此每个会话挂一条串行队列；不同会话之间并行。
6. **SSE 事件协议**：后端把 SDK 的底层事件映射为 `thinking / tool / text / done / error` 五类 SSE 事件，前端逐帧消费，实现近实时流式。
7. **安全**：`.env` 已被 `.gitignore` 忽略，凭据不落库；HTTP 服务默认绑 `127.0.0.1` + Bearer token 鉴权。

## 开发

```bash
# 后端（项目根目录）
npm install          # 安装依赖
npm run typecheck    # 类型检查
npm start -- <path>  # 交互式 REPL
npm run serve --     # HTTP 服务

# 前端（web/ 目录）
cd web && npm install
npm run dev          # 开发服务器 http://127.0.0.1:5173
npm run build        # 生产构建（产物在 web/dist）
```

## 说明与已知限制

- **远程仓库浅克隆**（`--depth 1`）：`git log` 历史只有 1 条提交，`git blame` 仅对当前快照有效。如需完整历史，可修改 `src/project-resolver.ts` 中的 clone 命令去掉 `--depth`。
- **扩展工具**：默认会加载 `~/.pi/agent/extensions` 与 `<cwd>/.pi/extensions` 下的扩展。若某个扩展注册了写能力的工具，本工具无法拦截（这是 pi 本身的信任模型）。如需彻底隔离，可在 `session-factory.ts` 中改用自定义 `ResourceLoader` 并清空扩展路径。
- **模型/凭据**：默认复用本机 pi 的配置（`~/.pi/agent`），也可用环境变量 / `.env` 覆盖（见「配置」一节）。模型默认优先选 `deepseek/deepseek-v4-pro`。注意：若 `~/.pi/agent/settings.json` 里的 `defaultModel` 指向了一个不存在的模型 id（例如 `deepseek-v4-flash`），本工具会自动忽略并改用可用模型。
