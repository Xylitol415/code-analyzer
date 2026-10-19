# Steering 与 Follow-up 实施记录

## 已确认设计

- 网页空闲显示发送；回答中显示引导、排队和停止当前。Enter 在忙时排队，Shift+Enter 换行。
- 用户选中「完整消息卡片」：待处理列表固定在输入框上方，显示原文、类型、状态、撤回编辑和删除。
- 撤回与删除先通过后端确认；只允许取消尚未采用／执行的消息。编辑回填不得覆盖已有草稿。
- 停止只影响当前任务，排队继续。新建／退出清空全部任务；引导绑定准确的原任务，不能误入下一任务。
- 后端保管可撤回引导，通过 pi 公共循环钩子在下一执行边界投递。独立 follow-up 复用 SessionQueue/runAsk，保持每轮 Skills 与知识校验。

## 协议（前后端共用）

`PendingSessionMessage = {id, question, mode: "steer" | "followUp", targetRequestId?, createdAt: number, status: "pending" | "unapplied", reuse?: "auto" | "bypass"}`。

`SessionMessageState = {revision: number, activeRequestId: string | null, pending: PendingSessionMessage[]}`。

- `POST /sessions/:id/ask` 保留原接口，可选 `mode: "followUp"`。SSE `queue` 为完整状态；`started` 为 `{requestId,question,revision}`，其后才有该问题的模型输出。等待任务删除时发 `cancelled: {requestId}` 并关闭流。
- `POST /sessions/:id/steer` JSON `{question,requestId,targetRequestId}`，成功 202 `{message,state}`。任务已结束／目标不匹配为 409，保留草稿。
- `GET /sessions/:id/messages` 返回完整 `SessionMessageState`。
- `DELETE /sessions/:id/messages/:messageId` 成功 `{message,state}`；执行／采用后 409，重复删除幂等。不能通过该接口停止活动问题。
- 当前活动 SSE 接收 `steering_applied: {requestId,question,targetRequestId}`。前端结束之前的回答段，显示引导用户消息，继续在新的回答段接收输出。
- 所有接口沿用 Bearer Token。状态以 revision 防止响应乱序。

## 实施任务

### Task 1：后端协调器与协议

- [x] 先添加确定性任务、撤回、执行竞态、跨任务引导、关闭回归。
- [x] 新增 `src/session-messages.ts`、共享类型，接入 registry/server/runAsk，保留原调用兼容。
- [x] 采用公开的 agent.finishTurn / prepareNextTurnWithContext；不修改 SDK 私有队列。
- [x] 引导失败、停止或任务已结束而未采用时保留为 unapplied，允许编辑／删除。
- [x] 后端及 HTTP 测试通过。

### Task 2：前端完整消息卡片

- [x] client/types/useChat 接入多任务事件与消息取消，旧流不能覆盖新会话。
- [x] MessageInput 添加完整卡片、按钮、忙时 Enter 排队，保持单行自动高度修复。
- [x] 撤回编辑须后端成功才回填；输入框有草稿时阻止覆盖；失败保留卡片和草稿。
- [x] 排队消息只在 started 后进入历史；引导只在 adopted 后进入历史，按任务隔离输出。
- [x] 前端测试与 build 通过。

### Task 3：记忆、历史与集成验证

- [x] 引导记录追加到答案原始问题上下文，重试仍使用原 requestId/question 身份；候选不误绑定原始短问题。
- [x] 每轮引导只能使用当前 Skills 快照，不提升权限；补充 URL 授权仍只来自实际用户原文。
- [x] 真实 pi + 本机模拟提供商覆盖 steering 工具边界、撤回和 follow-up；不调用真实模型。
- [x] root/web 测试、类型检查、构建、浏览器交互通过，更新 README 使用与接口。

## 边界检查与验证

- finishTurn 决定继续执行时锁定引导，之后撤回返回 409；prepareNextTurnWithContext 真正投递后才发送 steering_applied。准备失败／停止而未投递的消息恢复为 unapplied，避免成功撤回后产生无输入的额外模型轮次。
- 上下文准备期间 SDK 尚未进入 streaming，拒绝引导并保留用户草稿，防止提前展开上一轮 Skills 快照。
- started 带执行 revision。前端按请求分组和排序，独立 SSE 迟到的开始、增量、引导、最终答案不会抢占最新任务或改变消息归属。
- 后端完整测试 152 项通过；前端完整测试 116 项通过；后端类型检查、前端构建通过。
- 本机浏览器完整卡片交互 7 项、原输入框高度检查 12 项通过。使用模拟数据和本机模型替身；未请求真实模型。
- 独立检查发现的问题均已修复并补回归；最后定向复查无剩余 P1／P2 问题。本地提交序号与后端执行 revision 分开，连续离线失败后的恢复不影响任务控制。

## 执行约束

复用当前 `codex/fix-session-lifecycle` checkout，保留既有 MessageInput 单行修复；用户本轮未要求提交或推送。本轮不调整知识预算策略。Task 1/2 共享以上稳定接口，分别拥有 src/tests 与 web 文件，互不覆盖。最后单独进行完整变更审查。
