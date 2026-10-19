# 本地记忆与知识复用

## 工作方式

短期对话继续由 pi 的会话历史与压缩机制管理。独立的 `src/memory/` 保存可审核、可撤回的项目知识。

1. 完成的模型回答带稳定的回答 ID。失败、停止和旧版无 ID 的消息不提供知识反馈。
2. 回答下方保留复制、评价、书本收录三个图标，悬浮或键盘聚焦可查看说明。「评价回复」展开有帮助／无帮助／撤销评价，点踩时可填写原因；书本加号可直接收录候选。点赞与收录都不会自动发布。匿名浏览器标识只用于修改／撤销自己的反馈，不代表真实用户身份或可信票数。
3. 顶栏「知识库」查看候选，填写问题、答案、适用条件、文件与行号，点击「核验源码」阅读固定 Git 提交，再发布。
4. 全新会话的第一个真实问题，只有去除首尾空白后完全相同、项目／分支／提交／模型与提示词策略一致时，才直接返回审核答案；此路径没有模型调用。
5. 类似问题和后续问题可用 zvec 中文 BM25 检索已发布知识。最多检索 5 条、注入 3 条完整记录、约 1500 个估算 Token，作为临时用户参考数据；由模型判断适用条件。BM25 不等于语义理解，换一种完全不同的说法可能检索不到。

原文复制、点赞、点踩、收录与知识管理沿用现有 Tailwind 页面。欢迎语在本地展示，不调用模型。浏览器刷新后，反馈状态从后端恢复。

## 版本与失效

- 项目按规范化真实路径隔离。任意提交、分支或工作区干净状态变化，都会停止旧知识复用；采用整个项目版本校验，可能使无关改动也触发失效。
- 未提交／未跟踪文件、`assume-unchanged`、`skip-worktree`、子模块等无法安全确认的状态禁用复用。普通分析仍然可用。
- 发布校验固定提交中的普通文件、Git blob 与当前文件内容，拒绝越界、链接、二进制和无效行号。前后状态检查不能构成原子文件系统快照，不能保证抵御修改后又恢复的并发写入。
- 已使用知识被修订、暂停或撤回，或者源码在回答期间改变，会要求新建会话。旧历史保留，不通过删除历史来隐藏旧知识影响。「本次跳过知识复用」不会绕过旧上下文失效。
- 待复核知识可勾选「在当前代码版本重新核验」，重新阅读源码后发布新版本。原有版本与来源回答保留。
- 点踩可填写事实错误／过期／不相关／表达问题及说明。对直接复用答案的错误／过期反馈会暂停它实际引用的当前知识版本；旧版本反馈不会暂停新修订。审核者可复核后重新发布。

## 安装、数据与退出开关

```bash
npm install
npm run serve -- --port 8787 --token your-backend-token
# 另一个终端
npm --prefix web run dev
```

需要 Node.js ≥ 22.13。`@zvec/zvec@0.7.1` 是可选原生依赖，本次在 macOS arm64、Node 26.8.2 验证；其他平台需确认该包提供相应二进制。缺少 zvec 时，SQLite 仍能管理知识和进行严格直接复用，类似问题检索会降级为普通分析。旧 Node 或整个记忆服务不可用时，普通分析继续使用；已经引用过知识的上下文若无法核验，会要求新会话。

数据默认保存在 `~/.code-analyzer/memory/`：

| 数据 | 用途 |
| --- | --- |
| `state.sqlite` 及 WAL | 来源回答、反馈、不可变知识版本、待执行索引操作、复用请求日志；权威数据 |
| `index/<项目标识>` | zvec 全文索引，可从 SQLite 重建 |
| `flush-locks/`、索引 `.guard` | 跨进程协调；不在模型生成期间持锁 |
| `repl-client-id` | 当前本机 REPL 的匿名反馈标识 |

`CODE_ANALYZER_DATA_DIR` 可覆盖应用数据根目录。数据库包含问题、回答和源码片段，应和历史会话一起备份；备份 SQLite 时停止服务或使用 SQLite 一致性备份方式，不要只复制正在使用的主文件。关闭记忆功能：

```bash
CODE_ANALYZER_MEMORY=off npm run serve -- --port 8787 --token your-backend-token
```

关闭不删除历史知识。模型 API Key 和后端 Token 不写入记忆记录；用户自己在问题／答案中输入的内容仍会被保存，请勿粘贴凭据。当前仍使用单用户共享 Bearer Token 权限，匿名赞踩不能作为多人审核身份。

## 终端与 API

```text
/memory                         查看当前项目状态
/memory search <问题>            检索已审核知识
/memory bypass <问题>            本次直接分析
/feedback up                     对刚完成的回答点赞
/feedback down incorrect <说明>  反馈事实错误
/feedback clear                  撤销反馈
```

知识审核在网页进行。后端接口都需要已有的 Bearer Token：

| 接口 | 用途 |
| --- | --- |
| `GET /memory/knowledge?project=...&state=...` | 分页列表；状态 `candidate`／`published`／`needsreview` |
| `GET /memory/knowledge/:id` | 详情、历史版本与反馈 |
| `POST /memory/knowledge` | `{answerId}` 收录候选 |
| `PUT /memory/answers/:id/feedback` | `{clientId,vote,reason?,comment?}`；`vote` 为 `up`／`down`／`null` |
| `GET /memory/answers/:id/feedback?clientId=...` | 当前匿名标识的反馈状态 |
| `POST /memory/knowledge/:id/evidence` | 按 `expectedRevision`、`expectedSourceKey`、`evidence` 核验源码 |
| `POST /memory/knowledge/:id/review` | CAS 审核；`publish`／`revise`／`suspend`／`withdraw` |

原有 ask 请求可选 `requestId` 与 `reuse: "auto" | "bypass"`。相同历史、相同 requestId 的成功重试不会重复追加消息；冲突返回 409。JSON／SSE done 增加 `answerId`、`answerVersion`、`source`、`knowledgeIds`、`usage`，历史读取保留相同标识。`context_stale` 错误带 `newSessionRequired: true`。

## 验证与性能

```bash
npm test
npm run typecheck
npm --prefix web test
npm --prefix web run build
npm run memory:evaluate
npm run memory:benchmark
```

评估和性能脚本只操作临时 Git 仓库与临时应用数据，运行后清理，不调用真实模型或读取现有知识。固定样例将 20 个问题族分为开发／验收各 10 个，检查 8 类边界。它验证检索和失效机制，不能证明真实产品问答的事实准确率、Recall@5 或 Token 节省比例。

本机实测和局限见 [验证报告](evaluation/2026-10-19-memory-verification.md)。提供商缺少用量或生成回答的用量全零时显示 `unknown`／`null`，不当作实测零；只有直接复用标记 `no-model-call`。
