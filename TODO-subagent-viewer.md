# TODO: Subagent Session Viewer

Desktop 和 Web 前端都需要支持查看并行 subagent 的执行过程。点击 "Subagent executing..." 应该打开一个新窗口/tab，实时显示 subagent 在干什么。

## 现状

- `agent_subagent_jobs` 表已有每个 subagent 的 `subagentId`、`sessionId`、`task`、`status`、`summary`、`steps` 等字段
- `agent_subagent_batches` 表已有 batch 级别的并发度和计数
- 每个 subagent job 有独立的 `sessionId`（独立 session）
- CLI TUI 有 `WorkflowSubagentMessageComponent` 渲染颜色状态，但不支持展开查看详情
- Desktop 把 `workflow.subagent` custom message 当纯文本显示，无交互
- Web 前端无 subagent 查看 UI

## 需要做的

### 1. Web 后端 — API 端点

- [ ] `GET /api/cli/subagent/:subagentId` — 返回指定 subagent job 的 session messages
- [ ] `GET /api/cli/subagent-batch/:batchId` — 返回 batch 下所有 job 的状态概览
- [ ] 考虑 SSE 实时推送 subagent 进度（或者客户端轮询）
- [ ] 鉴权：复用现有 session auth，校验 subagent 属于当前用户的 session

### 2. Web 前端 — React UI

- [ ] Subagent batch 卡片组件：显示 N 个 subagent，各自状态（queued/running/completed/failed）
- [ ] 点击单个 subagent → 打开侧边面板或新页面，显示该 subagent 的对话流（messages + tool calls）
- [ ] 实时更新：subagent running 时显示 spinner + streaming output
- [ ] 在主聊天流中插入 batch 卡片的位置：收到 `subagent-batch-event` type=spawned 时

### 3. CLI Adapter

- [ ] `fetchSubagentSession(baseUrl, token, subagentId)` — 调用后端 API 拉取 subagent messages
- [ ] `fetchSubagentBatch(baseUrl, token, batchId)` — 拉取 batch 概览
- [ ] 导出到 `@agentboster/adapter` 的 index.ts

### 4. Desktop — Subagent 事件 UI + 新 Tab

- [ ] 在 `handleEvent` 中识别 `workflow.subagent` / `workflow.subagent.batch` custom message
- [ ] 渲染为可点击的 subagent 状态行（类似 workflow-view 的折叠行），带 spinner + 状态色
- [ ] 点击 → `createWorkspace` 或 `createSessionTab` 打开只读 session tab
- [ ] 新 tab 调用 `fetchSubagentSession` 拉取 messages，渲染为标准聊天视图（复用 chat-view 的 message rendering）
- [ ] 实时更新：轮询或 SSE 直到 subagent 完成

### 5. CLI TUI（可选增强）

- [ ] 现有 `WorkflowSubagentMessageComponent` 加展开支持，显示 subagent 的 task + summary
- [ ] 或者用 `ctx.ui.custom()` 打开全屏 subagent 详情视图

## 数据流

```
Web Backend DB (agent_subagent_jobs)
        │
        ├── SSE: subagent-event / subagent-batch-event
        │        │
        │        ├── CLI: onSubagentEvent → addWorkflowSubagentEvent → custom message
        │        │        │
        │        │        ├── TUI: WorkflowSubagentMessageComponent (已有)
        │        │        └── Desktop RPC: handleEvent → (需要: subagent card UI)
        │        │
        │        └── Web Frontend: (需要: batch card 组件)
        │
        └── REST: GET /api/cli/subagent/:id (需要新建)
                 │
                 ├── Desktop: 新 tab 拉取 subagent session
                 └── Web Frontend: 侧边面板拉取 subagent 对话
```

## 注意事项

- Subagent 的 session messages 可能很大（几十 KB），考虑分页或 lazy loading
- 鉴权要确保用户只能查看自己 session 下的 subagent
- Desktop 的新 tab 应该是只读的（不能向 subagent 发消息）
- Web 前端的 subagent 详情页 URL 设计：`/chat/:sessionId/subagent/:subagentId`
