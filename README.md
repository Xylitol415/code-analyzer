# code-analyzer

只读的代码逻辑分析助手：给定一个 git 项目路径（本地路径或远程 URL），即可交互式地分析代码逻辑。基于 [pi SDK](https://pi.dev/docs/latest/sdk) 构建。

## 快速开始

### 1. 环境要求

- Node.js ≥ 20
- 记忆与知识复用需要 Node.js ≥ 22.13（推荐当前 LTS）；使用内置 SQLite 与可选的 zvec 原生包。
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
- **交互式多轮问答与历史列表**：流式输出，可无限追问；会话按项目路径持久化，网页和终端均可选择新建，或从历史列表恢复任意一次讨论。
- **过程可视化**：实时展示模型的思考过程（reasoning）与工具调用（工具名、参数、耗时、结果预览）。
- **本地路径 + 远程 URL 都支持**：URL 自动浅克隆到 `~/.code-analyzer/repos/<hash>`，已克隆则复用。
- **可配置的模型与凭据**：复用本机 pi 配置，或在网页、REPL、HTTP 请求中指定 OpenAI 兼容接口的 Base URL、API Key 和模型名。
- **本地知识复用**：回答旁点赞／收录候选，在「知识库」核验源码并人工发布；同版本、同配置的首问可直接复用，类似问题检索参考证据。使用 SQLite + zvec 中文 BM25，不需要 Embedding 模型。设计和操作流程见[记忆与知识复用](#记忆与知识复用)。

**三种使用形态**

| 形态 | 说明 |
|------|------|
| 终端 REPL | 命令行交互式分析，零依赖快速上手 |
| HTTP 服务 | SSE 流式 + JSON，供 API / 脚本 / 前端调用 |
| Web 网页 | React 聊天界面，浏览器里可视化提问 |

## 用法

记忆与知识审核的使用、接口、失效规则与验证命令见 [本地记忆与知识复用](docs/memory.md)。

```bash
# 本地路径
npm start -- ./my-repo

# 远程 URL（自动 clone）
npm start -- https://github.com/user/repo.git

# 直接开全新会话，跳过启动选择
npm start -- ./my-repo --new

# 查看本项目历史列表（包含可复制的会话 ID，无需模型凭据）
npm start -- ./my-repo --list-sessions

# 恢复指定历史会话
npm start -- ./my-repo --session <会话ID>

# 显式恢复最近一次会话（没有历史时新建）
npm start -- ./my-repo --resume

# 覆盖默认模型
npm start -- ./my-repo --model deepseek/deepseek-v4-pro

# 自定义 OpenAI 兼容接口（key 从 CODE_ANALYZER_API_KEY / .env 读取）
npm start -- ./my-repo --base-url https://gateway.example.com/v1 --model organization/model-name

# 无鉴权本地接口；显式空 key 可覆盖环境变量中的 key
npm start -- ./my-repo --base-url http://127.0.0.1:11434/v1 --model qwen3 --api-key=

# 隐藏思考过程（reasoning 可能较长）
npm start -- ./my-repo --no-thinking

# 关闭彩色输出（适合脚本/管道）
npm start -- ./my-repo --no-color
```

> 输出里 `[思考]` 开头的是模型的推理过程（暗色），`⚙ 工具名` / `✓ · 耗时 → 结果预览` 是工具调用过程；正常回答为普通文本。

在交互终端中，不指定会话参数时会先展示按更新时间排序的历史列表。输入 `0` 或直接回车新建，输入序号恢复对应历史，输入 `q` 退出。选择列表显示标题、更新时间、消息数、模型和可复制的会话 ID。在脚本或管道等非 TTY 环境中不等待选择，默认新建；可用 `--session` 明确指定历史。

进入会话后直接提问，例如：

- 「这个项目的整体架构是什么？」
- 「登录鉴权的逻辑在哪，调用链怎么串的？」
- 「`src/auth.ts` 里这个函数做了什么？」

输入 `exit` / `quit` 或按 `Ctrl+D` 退出；`Ctrl+C` 中止当前回答。

### 参数一览

| 参数 | 作用 |
|------|------|
| `<路径或 URL>` | 本地 git 仓库路径，或远程 git URL |
| `--new` | 直接开全新会话，跳过启动选择 |
| `--resume` | 恢复最近一次会话；无历史时新建 |
| `--session <ID>` | 恢复本项目指定的历史会话 |
| `--list-sessions` | 列出本项目历史会话并退出，无需模型凭据 |
| `--model <模型>` | 已有模型填 `provider/id`；自定义接口填服务实际接受的完整模型名 |
| `--base-url <URL>` | 启用自定义 OpenAI Chat Completions 兼容接口 |
| `--api-key <key>` | 自定义接口的 API Key；省略时读取 `CODE_ANALYZER_API_KEY`，`--api-key=` 表示无鉴权 |
| `--no-thinking` | 隐藏思考过程 |
| `--no-color` | 关闭彩色输出 |
| `--help` | 帮助 |

带值参数同时支持 `--flag value` 和 `--flag=value`。`--api-key` 必须与 `--base-url` 一起使用；已有模型的凭据继续通过环境变量或 pi 配置指定。

`--new`、`--resume`、`--session`、`--list-sessions` 互斥。历史 ID 必须来自同一项目；不存在或其他项目的 ID 会报错，不会自动改为恢复最近一次。

仅查询历史不会触发远程仓库 clone；未缓存且没有历史的 URL 返回空列表。

### 历史会话存储

历史由 pi SDK 保存在 `~/.pi/agent/sessions/<项目路径编码>/` 下的 JSONL 文件中；设置 `PI_CODING_AGENT_DIR` 时使用该目录下的 `sessions/`。停止后端或释放活动会话不会删除历史，重启后仍可列表查询和恢复。尚未生成模型回复的空会话可能尚未写入磁盘，不会出现在历史列表。

恢复历史会保留原有上下文，后续问题接着该会话写入。网页同时展示已有消息；终端会打印恢复的消息数量。恢复时可以重新选择模型；自定义接口的 Base URL 和 API Key 不从历史中自动恢复，需要重新提供。

### 自定义 LLM

自定义模式使用 **OpenAI Chat Completions** 协议，Base URL 填 API 根路径（通常以 `/v1` 结尾），不要填写 `/chat/completions` 完整端点。模型名会原样发送，包含 `/` 时也不会拆成 provider。模型和网关需要支持工具调用，才能读取文件和分析仓库。

REPL 仅在显式提供 `--base-url` 时进入自定义模式：模型名按 `--model` > `CODE_ANALYZER_MODEL` 选择，API Key 按 `--api-key` > `CODE_ANALYZER_API_KEY` 选择。若两处都没有 key，则适用于无鉴权本地服务。通过环境变量提供 key 可以避免将 key 写入命令行。

自定义配置只用于当前会话；修改 Base URL、API Key 或模型后需重新建立会话。

API Key 不写入 pi 凭据文件或浏览器存储；恢复历史时需重新提供自定义配置。空 key 使用固定的 `not-required` 占位值满足 SDK 请求要求，不读取服务器凭据。自定义模型目前采用文本与工具调用模式，按 32K 上下文、最多 4096 输出 token 配置；不自动识别模型能力。

## 配置（API Key 与模型）

默认复用本机 pi 的全局配置（`~/.pi/agent/auth.json` + `models-store.json`）。也可改用**环境变量**或项目根目录的 **`.env` 文件**覆盖：

| 环境变量 | 作用 | 示例 |
|----------|------|------|
| `CODE_ANALYZER_API_KEY` | API key（应用于所选模型的 provider） | `sk-...` |
| `CODE_ANALYZER_MODEL` | 已有模型的 `provider/modelId` 或 `modelId`；CLI 指定 `--base-url` 时用作完整模型名 | `deepseek/deepseek-v4-pro` |
| `CODE_ANALYZER_BASE_URL` | （可选）覆盖已有模型 provider 的 API base URL，不启用自定义模式 | `https://api.deepseek.com` |

已有模型模式的优先级：**命令行 `--model` / HTTP `modelId` > 系统环境变量 > `.env` 文件 > 全局 `~/.pi/agent` 配置**。CLI `--base-url` 与 HTTP `llm` 对象会使用各自明确指定的自定义配置；HTTP `llm` 的 key 省略或为空时，不会回落到服务端环境变量或 pi 凭据。

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
| GET | `/models` | 列出可用模型 + 默认推荐（`{models:[{provider,id,name}], default}`） |
| GET | `/history?project=<项目路径或URL>` | 本项目持久化历史，返回 `{projectPath, sessions:[{id,title,createdAt,updatedAt,messageCount,modelLabel?,active?,activeSessionId?}]}` |
| POST | `/sessions` | 建会话或恢复，body `{project, historyId?, resume?, modelId?, llm?, sessionId?}` → `{id, historyId, projectPath, modelLabel, resumed, messages}` |
| GET | `/sessions` | 列出活动会话 |
| POST | `/sessions/:id/ask` | 提问／排队，body `{question, requestId?, reuse?, mode?: "followUp"}`；默认 SSE 流式，`?stream=false` 返回 JSON |
| POST | `/sessions/:id/steer` | 引导当前任务，body `{question, requestId, targetRequestId}`；202 返回 `{message,state}` |
| GET | `/sessions/:id/messages` | 查看活动任务与待处理消息，返回 `{revision,activeRequestId,pending}` |
| DELETE | `/sessions/:id/messages/:messageId` | 撤回尚未执行／采用的消息，返回 `{message,state}`；已执行／采用返回 409 |
| DELETE | `/sessions/:id` | 释放会话 |
| POST | `/ask` | 一次性提问，body `{project, question, modelId?, llm?, requestId?, reuse?}`；默认 JSON，`?stream=true` 流式 |

`llm` 格式为 `{baseUrl: string, model: string, apiKey?: string}`，与 `modelId` 互斥。`baseUrl` 与 `model` 必填；`apiKey` 省略或空字符串表示无鉴权，不使用服务器已有凭据。`/models` 只返回服务器已配置的模型；自定义模型不需要出现在该列表中。

使用已有的活动 `sessionId` 建会话会复用原会话及其模型配置；切换 LLM 时请创建新的会话。

`GET /sessions` 返回当前后端进程中的活动会话，`GET /history` 返回磁盘上的持久化历史，两者 ID 用途不同。将历史条目的 `id` 作为 `POST /sessions` 的 `historyId` 即可恢复指定会话；返回的 `id` 用于后续 `/sessions/:id/ask` 和释放操作。`historyId` 与 `resume: true` 互斥。复用已有 `sessionId` 时，项目和显式指定的 `historyId` 必须与原会话一致，否则返回 409。恢复响应的 `messages` 包含当前分支的用户/助手消息，以及思考、工具和停止状态，查询与恢复本身不会调用模型生成问候或总结。

历史列表的 `active` 和重复打开保护作用于当前 HTTP 后端进程；独立 REPL 或其他后端进程之间不共享占用状态。

历史的 `activeSessionId` 标识当前占用它的运行时连接。通过 `DELETE /sessions/:activeSessionId` 可退出该连接、中止其任务并保留历史；精确使用列表中的运行时 ID，避免旧的退出操作误关后来恢复的新连接。会话创建或清理尚未完成时可能只有 `active: true`，稍后刷新列表即可。

HTTP 请求头中的 Bearer Token 是 **code-analyzer 后端访问令牌**；`llm.apiKey` 是 **模型服务凭据**，两者用途不同。

`reuse` 默认为 `"auto"`；`"bypass"` 跳过本次知识查询，直接分析。`requestId` 用于同一历史会话中已成功请求的重试，避免重复追加消息；相同 ID 配合不同问题会返回 409。知识列表、反馈与审核接口见[记忆接口说明](docs/memory.md#终端与-api)，沿用同一 Bearer Token。

### curl 示例

```bash
TOKEN=my-secret-key
BASE=http://127.0.0.1:8787

# 查询项目历史列表
curl -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "project=./my-repo" "$BASE/history"

# 恢复列表中的指定历史（historyId 替换为真实 ID）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo","historyId":"历史列表中的ID"}' "$BASE/sessions"

# 一次性提问（JSON）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo","question":"这个项目做什么？"}' "$BASE/ask"

# 建会话（多轮）
SID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo"}' "$BASE/sessions" | jq -r .id)

# 使用自定义本地 LLM 建会话（无鉴权示例）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"./my-repo","llm":{"baseUrl":"http://127.0.0.1:11434/v1","model":"qwen3"}}' \
  "$BASE/sessions"

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
| `queue` | `{revision,activeRequestId,pending}` 完整队列状态，用递增 revision 避免旧响应覆盖新状态 |
| `started` | `{requestId,question,revision}` 该请求开始执行；revision 用于排列跨 SSE 连接到达的消息 |
| `steering_applied` | `{requestId,question,targetRequestId}` 引导被当前任务采用，之后的输出属于新回答段 |
| `cancelled` | `{requestId}` 等待中的请求被删除，随后关闭该请求的 SSE |
| `done` | `{"modelLabel":"...","answer":"最终回答段"}`；引导前已输出的回答段保留 |
| `error` | `{"message":"..."}` |

记忆功能可用且回答成功完成时，JSON 响应和 SSE `done` 还会包含 `answerId`、`answerVersion`、`source`、`knowledgeIds` 与 `usage`，恢复历史时保留这些标识。`source` 区分模型生成（`generated`）、知识直接复用（`exact`）和参考知识生成（`assisted`）。旧上下文失效时返回 `code: "context_stale"`、`newSessionRequired: true`；JSON 使用 HTTP 409，已经建立的 SSE 通过 `error` 事件通知。

> 同一会话的请求会**串行排队**（pi 的单会话模型同一时刻只允许一个 prompt）；不同会话之间并行。客户端断开 SSE 连接时，仅取消该连接对应的请求：排队中的请求会被跳过，正在执行的请求会被中止，其他请求不受影响。

引导消息绑定 `targetRequestId`，在 pi 下一次助手执行边界采用，不会立即中断正在接收的输出。上下文准备中或任务已结束时提交引导返回 409，网页保留草稿，可稍后重试或排队。未采用时可通过 DELETE 撤回；目标任务结束／停止后仍未采用的引导标记为 `unapplied`，不会进入下一任务。每条排队问题有独立的 ask/SSE 生命周期，按顺序重新校验源码、知识与 Skills。每会话最多保留 50 条待处理消息，超过返回 429；待处理状态只保存在当前后端进程内，重启后清空。

引导会作为真实用户消息写入历史；知识候选的问题同时包含原问题和已采用的更正，避免更正后的答案被关联到原问题。重试仍以原始 `requestId` 和问题进行匹配。引导使用本轮已加载的 Skills 快照，技能配置变更在下一条独立问题执行时生效。

`DELETE /sessions/:id` 会立即移除活动会话、拒绝新任务并跳过尚未执行的任务，等待当前任务及其中止操作结束后再释放资源。删除操作只释放运行中的会话，不删除磁盘上的历史记录。Web 在新建、重新连接或组件卸载时调用此接口；网络断开或浏览器崩溃时仍可能无法送达清理请求。

## Web 前端

一个单页聊天前端（`web/` 目录），通过 SSE 实时消费上面的 HTTP 接口。

技术栈：Vite + React 19 + TypeScript + Tailwind CSS v4 + react-markdown（代码高亮）+ Mermaid（图表）+ @microsoft/fetch-event-source（POST + SSE）。

### 启动

```bash
# 1. 先起后端（记住 token）
npm run serve -- --port 8787 --token my-secret-key

# 2. 再起前端
cd web && npm install && npm run dev
# 打开 http://127.0.0.1:5173
```

点击右上角「会话配置」，填写「后端地址 + Token + 项目路径」，然后选择新建会话，或从该项目的历史列表中选择要恢复的讨论。历史列表显示标题、更新时间和消息数，可手动刷新。继续选择模型配置方式：

- **已配置模型**：从后端返回的模型列表中选择。
- **自定义 OpenAI 兼容接口**：填写 LLM Base URL、模型名与 API Key。无鉴权本地服务可留空 API Key；此模式不依赖后端模型列表。

确认后配置面板自动收起，可以开始提问。恢复历史时会直接展示已有对话，继续提问会沿用之前的上下文。页面的后端 Token 和模型 API Key 分开填写；鉴权失败会明确显示错误。模型配置修改后需重新连接，生效的配置以新建或恢复会话时的选择为准。

会话配置会在浏览器 `localStorage` 中记住最近 10 组**成功连接**的项目、后端地址、模型模式及模型配置。下次打开页面会预填上次配置；也可通过「本地配置记录」一键回填，或从各输入框的历史候选中选择。重复使用的配置会排到最前，可用「清空配置记录」删除记录。

**后端 Token 和 LLM API Key 不保存**；刷新后及整组回填后需重新填写凭据。含账号密码或查询参数的地址不会写入配置记录。回填只修改配置草稿，不会自动建会话或切换当前连接。记录仅在当前浏览器、当前站点（域名和端口）下有效，不会上传服务端或跨设备同步；浏览器禁止存储时仍可正常使用会话。

刷新、关闭或离开网页时，前端通过 `pagehide` 发送带鉴权的 `keepalive` 请求退出当前会话。浏览器崩溃、断网等情况下自动清理可能无法送达；可在历史列表中点击使用中条目旁的「退出会话」，确认后释放占用，再选择该历史继续。退出会保留历史记录；如果该会话仍被其他窗口使用，也会中止其任务。

功能：流式回答（Markdown 渲染）、思考过程/工具调用可折叠查看、多轮追问、按项目列出与恢复历史、新建会话、停止回答，以及顶栏「技能」「知识库」管理入口。

### 回答中的引导与排队

- **空闲时**：点击「发送」或 Enter，立即执行问题。
- **回答中**：点击「引导」更正当前任务，或点击「排队」等待当前任务完成后独立回答；此时 Enter 默认排队，Shift+Enter 换行。
- **待处理卡片**：固定展示在输入框上方，区分「待采用」「待执行」「未采用」。点击「撤回编辑」会先取消后端消息，再将原文回填；输入框已有草稿时会提示先处理草稿。「删除」直接取消后端待处理消息。
- **执行边界**：已经采用／开始执行的消息不能撤回，页面保留明确提示。点击「停止当前」只中止当前问题，排队问题继续；新建／退出会话会清空待处理消息。

回复中的 `mermaid` 围栏代码块会直接绘制为图表，页面隐藏源码。完整图块可在回复继续生成时显示；尚未闭合时显示生成提示，停止后未完成或语法错误时显示说明。图表按需加载并适配消息宽度，特别宽的架构图可横向滚动。

非空 AI 回复在完成或停止后，下方会出现复制图标。点击后将完整 Markdown 原文复制到系统剪贴板，包含 Mermaid 源码，不包含思考和工具记录；成功会显示「已复制」。剪贴板功能需要 HTTPS 或 localhost 等浏览器允许的安全环境，权限失败时会显示重试提示。

成功完成且带回答 ID 的回复另有「评价回复」与书本收录图标；悬浮或键盘聚焦可查看说明，点击评价图标展开有帮助／无帮助／撤销评价。知识复用来源会在回复中标识，具体流程见下一节。

## 记忆与知识复用

面向重复的代码逻辑问题，将有价值的回答整理为带源码证据、适用条件和版本的项目知识。已审核答案可以减少重复分析，并让相同问题在相同条件下得到一致回答；知识需要经人工发布才参与复用。

### 分层设计

| 层次 | 实现 | 职责 |
| --- | --- | --- |
| 短期对话上下文 | pi SDK 会话历史与压缩机制 | 支持当前讨论中的多轮追问、持久化和历史恢复 |
| 长期项目知识 | `src/memory/` + SQLite | 保存来源回答、反馈、不可变知识版本、源码证据与复用记录，作为权威数据 |
| 本地检索索引 | 可选的 `@zvec/zvec@0.7.1` | 用 jieba 中文分词和 BM25 全文检索已发布知识，可从 SQLite 重建 |

当前使用 zvec 的全文索引能力，**没有向量字段，不需要在线或本地 Embedding 模型，也不需要独立数据库服务**。BM25 按词项匹配，完全换一种说法时可能检索不到；检索命中也不代表答案一定适用。

SQLite、Git 快照校验与 zvec 原生操作放在后台 Worker 中，避免阻塞 HTTP 主线程。知识发布与待执行索引操作在同一 SQLite 事务中保存，再按项目加跨进程锁同步索引；失败的操作保留重试，不在模型生成期间持有索引锁。Web、HTTP 与独立 REPL 共用该服务和本地数据。

### 提问时如何复用

| 路径 | 触发条件 | 结果 |
| --- | --- | --- |
| 直接复用 `exact` | 全新会话首个真实问题，去除首尾空白后完全相同，且知识与当前源码、策略配置匹配 | 返回已发布 Markdown 答案，**不调用模型**，同时写入真实对话历史 |
| 参考知识 `assisted` | 类似问题或后续问题检索到适用的已发布知识 | 把知识作为本轮临时参考，由模型结合问题继续分析和回答 |
| 普通分析 `generated` | 未命中、主动跳过复用，或全文索引不可用且未命中严格直接复用 | 使用现有只读工具与模型分析 |

复用范围绑定**项目真实路径、分支、完整 Git 提交及工作区状态**，并校验策略哈希：实际系统提示词、已启用 Skills 版本、模型及接口配置；凭据不参与记录。不同项目目录互相隔离。

参考知识最多检索 5 条、注入 3 条完整记录，预算约 1500 个估算 Token。参考内容包含适用条件和文件行号，以本轮用户参考数据提供给模型，不授予额外工具权限。检索采用 300 ms 软等待预算，超时可继续普通分析；该预算不代表整个请求的延迟上限。

直接复用能省去该次模型调用；参考知识仍需调用模型，实际节省取决于问题和后续分析。用量缺失时显示 `unknown`／`null`，不当作零消耗；只有直接复用标记 `no-model-call`。

### 网页：收集、审核与维护

1. **收集候选**：回答下方点击评价图标选择「有帮助」，或点击书本加号收录。点赞和收录均只创建候选，票数不会自动触发发布。失败、停止和旧版无回答 ID 的消息不能进入该流程。
2. **整理内容**：打开顶栏「知识库」，在候选中编辑问题、答案、适用条件及源码文件行号。已连接时始终绑定会话实际的项目和后端地址。
3. **核验并发布**：点击「核验源码」，阅读固定 Git 提交中的证据后人工发布。发布检查普通受版本控制文件、Git blob、当前文件内容和行号；不接受链接、二进制或无效范围。
4. **复用与追溯**：在源码与策略匹配的新会话中提问；回复标记直接复用或参考知识生成，并保留回答 ID、引用的知识版本和用量信息。
5. **复核与撤回**：在「候选／已发布／待复核」列表维护知识，可修订、暂停或撤回。代码更新后，通过「在当前代码版本重新核验」核对证据并发布新版本；旧版本和来源回答保留。

「无帮助」可记录事实错误、内容过期、不相关或表达问题及说明。针对**直接复用答案**的事实错误／过期反馈，会暂停它实际使用的当前知识版本；旧版本反馈不会暂停后来发布的新修订。审核更新带 revision 校验，多窗口同时修改时返回冲突，避免覆盖他人的变更。浏览器刷新后可恢复或撤销自己的反馈。

### 终端使用

```text
/memory                         查看当前项目知识和索引状态
/memory search <问题>            检索当前源码版本下的已发布知识
/memory bypass <问题>            本次跳过知识查询，直接分析
/feedback up                     对刚完成的回答点赞，生成待审核候选
/feedback down incorrect <说明>  反馈事实错误
/feedback clear                  撤销评价
```

知识审核在网页进行。网页输入框下的「本次跳过知识复用」与 `/memory bypass` 对应，API 使用 `reuse: "bypass"`。

### 版本失效与上下文边界

- **工作区需干净**：未提交／未跟踪文件，以及 `assume-unchanged`、`skip-worktree`、子模块等无法安全确认的状态，会禁用知识复用；新会话仍可普通分析。
- **按整个项目版本校验**：分支、提交或干净状态变化后，旧知识停止适用，无关代码的提交也可能触发失效。源码校验使用前后检查，不是原子文件系统快照，无法保证识别修改后又恢复的并发写入。
- **旧上下文不能静默继续**：已记录回答的源码版本变化、已引用知识被修订／暂停／撤回，或已有知识上下文无法核验时，会要求新建会话，原历史保留。恢复历史也执行这些检查；「跳过知识复用」不会清除旧上下文的影响。

### 运行要求、存储与开关

使用 Node.js ≥ 22.13 后随应用启用，无需单独启动服务。zvec 是可选原生依赖，目前验证环境为 macOS arm64、Node 26.8.2；其他平台需确认对应二进制可用。缺少 zvec 时，SQLite 知识管理和严格直接复用仍可工作，类似问题检索降级为普通分析。Node 版本较旧时记忆功能不启用，普通分析仍可用。

| 位置或配置 | 用途 |
| --- | --- |
| `~/.code-analyzer/memory/state.sqlite` 及 WAL | 来源回答、反馈、知识版本、索引待办与复用请求日志 |
| `~/.code-analyzer/memory/index/<项目标识>` | 可重建的 zvec 全文索引 |
| `CODE_ANALYZER_DATA_DIR` | 覆盖应用数据根目录；使用相同目录的 HTTP 与 REPL 可共享知识 |
| `CODE_ANALYZER_MEMORY=off` | 关闭记忆功能，保留已保存的数据 |

```bash
# 临时关闭记忆与知识复用
CODE_ANALYZER_MEMORY=off npm run serve -- --port 8787 --token my-secret-key
```

数据库保存问题、答案和源码片段，应与历史会话一起备份；备份 SQLite 时停止服务或使用一致性备份方式。模型 API Key 和后端 Token 不写入记忆记录，用户自行粘贴到问题／答案中的内容仍会保存。当前采用单用户、共享后端 Token 权限模型，匿名反馈标识不代表真实用户身份，也不能据此判断多人认可。

详细接口、故障降级与验证命令见[本地记忆与知识复用](docs/memory.md)，设计取舍见[zvec 可行性调研](docs/research/2026-10-19-zvec-memory-feasibility.md)。[验证报告](docs/evaluation/2026-10-19-memory-verification.md)记录了原生包验证、检索样例和性能数据；固定样例用于验证机制，不能作为真实业务准确率或 Token 节省比例的证明。

## 架构与设计

### 目录结构

```
code-analyzer/
├── src/                        # 后端（Node + TypeScript + pi SDK）
│   ├── main.ts                 # CLI 入口
│   ├── cli-args.ts             # CLI 参数解析与自定义模型配置
│   ├── session-picker.ts       # 终端启动时的新建/历史会话选择
│   ├── project-resolver.ts     # 识别本地路径 / 远程 URL，URL 自动 clone
│   ├── session-factory.ts      # 核心：创建只读会话 + 模型/key/baseURL 解析
│   ├── session-history.ts      # 持久化历史列表、指定会话恢复、消息转换
│   ├── llm-config.ts           # 自定义 OpenAI 兼容配置校验
│   ├── git-tool.ts             # 自定义只读 git 工具（白名单子命令）
│   ├── repl.ts                 # 终端 REPL（流式 + 思考/工具可视化）
│   ├── server.ts               # HTTP 服务（Hono，SSE + JSON，Bearer 鉴权）
│   ├── session-registry.ts     # 会话注册表 + 每会话串行队列
│   ├── session-messages.ts     # 待处理消息、引导采用边界与撤回协调
│   ├── memory/                 # 记忆与知识复用：运行时、SQLite、zvec、源码校验、Worker
│   ├── memory-routes.ts        # 知识列表、反馈、证据核验与审核接口
│   └── config.ts               # .env / 环境变量加载
└── web/                        # 前端（React + Tailwind）
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

1. **项目只读**：仅启用 `read/grep/find/ls`、自定义只读 `git` 和准备技能预览的工具。模型只能把技能写入应用暂存区；正式安装由用户在宿主界面确认。没有修改项目或执行脚本的工具。
2. **会话持久化**：用 pi SDK 的 `SessionManager` 按项目路径持久化会话，通过历史 ID 恢复选中会话的当前分支；保留 `resume` 恢复最近会话的兼容入口。
3. **模型显式解析**：`ModelRuntime.create()` + `getModel` / `getAvailable` 显式选模型，默认优先 `deepseek/deepseek-v4-pro`，避免配置里失效的 `defaultModel` 导致静默失败。
4. **配置优先级**：已有模型采用 `--model` / HTTP `modelId` > 系统环境变量 > `.env` 文件 > 全局 `~/.pi/agent`。自定义 LLM 使用会话级配置；HTTP 自定义凭据不回落到服务端凭据。
5. **并发模型**：pi 的单会话同一时刻只允许一个 prompt，因此每个会话挂一条串行队列；不同会话之间并行。
6. **SSE 事件协议**：包含 `thinking / tool / text / done / error`，以及技能预览 `skill_preview` 和本轮技能快照 `skills_applied`。
7. **安全**：`.env` 已被 `.gitignore` 忽略，凭据不落库；HTTP 服务默认绑 `127.0.0.1` + Bearer token 鉴权。
8. **知识复用独立分层**：pi 管短期上下文，`src/memory/` 管经人工审核的长期项目知识。SQLite 是权威存储，zvec 只做可重建索引；复用前校验源码和策略版本，失效的历史上下文要求新建会话。

## 开发

```bash
# 后端（项目根目录）
npm install          # 安装依赖
npm test             # 会话取消、关闭与模型请求准备阶段的回归测试
npm run typecheck    # 类型检查
npm start -- <path>  # 交互式 REPL
npm run serve --     # HTTP 服务

# 前端（web/ 目录）
cd web && npm install
npm test             # 前端会话清理与流式请求竞态回归测试
npm run dev          # 开发服务器 http://127.0.0.1:5173
npm run build        # 生产构建（产物在 web/dist）
```

## 说明与已知限制

- **远程仓库浅克隆**（`--depth 1`）：`git log` 历史只有 1 条提交，`git blame` 仅对当前快照有效。如需完整历史，可修改 `src/project-resolver.ts` 中的 clone 命令去掉 `--depth`。
- **资源加载**：使用受控的 ResourceLoader；不会自动加载 pi 扩展、包、脚本、提示词模板或本机技能。项目 AGENTS 上下文仍可读取；模型和凭据配置仍复用 pi。
- **模型/凭据**：默认复用本机 pi 的配置（`~/.pi/agent`），也可用环境变量 / `.env` 覆盖（见「配置」一节）。模型默认优先选 `deepseek/deepseek-v4-pro`。注意：若 `~/.pi/agent/settings.json` 里的 `defaultModel` 指向了一个不存在的模型 id（例如 `deepseek-v4-flash`），本工具会自动忽略并改用可用模型。

## Skills 管理

网页顶栏的「技能」可管理当前项目的技能。已连接会话时始终使用会话实际的项目和服务地址；未连接时使用配置中的项目。

1. 上传一个 `SKILL.md`、包含一个技能目录的 ZIP，输入公开 HTTPS 文件链接或 GitHub 技能目录地址，或从本机候选技能中导入。
2. 检查预览的名称、描述、来源、附件清单、兼容提示及同名替换。
3. 点击「安装并在当前项目启用」。仅准备预览不会改变已启用技能；预览有效期为 15 分钟。

普通 HTTPS 文件链接只导入该文件。需要参考资料或资源文件时，使用 ZIP 或 GitHub 目录。GitHub 多技能仓库需指定含 `SKILL.md` 的子目录；私有技能通过上传导入。不向下载站点发送后端 Token 或模型 API Key。

使用 fake-IP 代理时，域名可能解析到 `198.18.0.0/15` 等保留地址，导入会按安全规则拒绝。可为技能来源域名配置真实公网 DNS 解析，或使用文件/ZIP 上传；应用不提供跳过内网地址校验的开关。

也可对 Agent 说「帮我安装这个 Skill：https://github.com/example/skills/tree/main/code-review」。Agent 只能调用 `prepare_skill_import` 生成预览，网页显示确认卡片；终端在本轮回复结束后询问确认。

### REPL 命令

```text
/skills                         查看当前项目的技能
/skills import ./my-skill       从本机目录、SKILL.md、ZIP 或 HTTPS URL 准备预览
/skills import https://github.com/example/skills/tree/main/code-review
/skills enable code-review      启用已安装技能
/skills disable code-review     禁用该技能
/skills confirm <预览ID>        明确确认预览（非交互终端不会自动确认）
/skill:code-review 解释调用链     通过 pi 原生命令显式加载技能正文
```

### 生效时机与存储

- 技能库默认保存在 `~/.code-analyzer/skills/`。可用 `CODE_ANALYZER_DATA_DIR` 指定应用数据根目录，HTTP 与独立 REPL 使用相同目录即可共享技能。
- 按真实项目路径隔离启用配置。相同名称每个项目只启用一个内容哈希版本；重新导入可更新，旧版本资源保留，便于历史引用。
- 文件锁及原子写入覆盖多网页和独立进程。安装确认使用预览中同一份文件，重试确认不会重复更新。
- 配置变更在会话下一次排队提问时应用，运行中的回答保持原快照；每轮将技能 ID、版本和配置 revision 记录到会话元数据。恢复历史会话时采用当前项目的启用清单。
- 禁用技能不会清除历史中已经读取的正文指令；需要清除这部分上下文影响时请新建会话。
- 本机 `.agents/skills` 和 pi 技能只作为可导入候选，需显式导入启用。`disable-model-invocation` 为 true 的技能不出现在自动发现摘要中，仍可显式调用。

### 边界与接口

附带脚本仅保存，不运行；`allowed-tools` 不会授予权限。导入不执行扩展、安装钩子或 npm/Git 包。仅接受公开 HTTPS，检查 DNS 及每次重定向；拒绝本地、回环和内网地址。ZIP 拒绝路径穿越、链接和多技能目录。上传、下载、解压内容各上限 20 MiB，最多 200 个文件，`SKILL.md` 上限 256 KiB。

接口全部沿用 `Authorization: Bearer <后端 Token>`：

| 接口 | 请求 | 结果 |
|---|---|---|
| `GET /skills?project=...` | 项目路径或已缓存 Git URL | 技能库、本机候选、项目启用状态及 revision |
| `POST /skills/imports` | JSON `{project,url}` / `{project,localId}`；上传用 multipart `{project,file}` | 绑定项目的预览 |
| `POST /skills/imports/:id/confirm` | 无需传项目 | 确认安装及项目启用快照 |
| `PATCH /skills/:id` | JSON `{project,enabled,version?}` | 更新后的项目快照 |

沿用单用户、共享后端 Token 的权限模型，不能据此隔离互不信任的多个用户。技能是模型指令，需要用户信任其来源；仅授予读取分析工具的范围。
