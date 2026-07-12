# TODO: Subagent 可视化 + agentd 功能增强

跨 agentd / web 后端 / web 前端 / CLI adapter / desktop 的统一规划。核心目标：让用户能看到并行 subagent 在干什么，同时增强 agentd 的能力。

## 现状

**已有的基础设施**:
- agentd `tools_subagent.go`: goroutine 并行执行，独立沙箱，state file 持久化
- agentd `subagent_runner.go`: P0.1 goroutine launcher
- Web 后端 DB: `agent_subagent_jobs` + `agent_subagent_batches` 表
- Web 后端 SSE: `subagent-event` / `subagent-batch-event` 推送到 CLI
- CLI: `onSubagentEvent` → `addWorkflowSubagentEvent` → custom message 注入 session
- CLI TUI: `WorkflowSubagentMessageComponent` 渲染颜色状态（仅文本，不可展开）
- Desktop: 把 `workflow.subagent` 当普通 custom message 显示纯文本

**缺失的**:
- 无法查看 subagent 的对话历史（messages / tool calls）
- Desktop 无 subagent 专用 UI（无 spinner、无状态色、无点击交互）
- Web 前端无 subagent 查看页面
- agentd 无查询 subagent session 的 API

---

## Phase 1: agentd — Subagent 查询 API + Advisor 端点

### 1.1 Subagent Session 查询

agentd 是 subagent 的实际执行者，数据在它手里。

```
GET  /api/v1/subagents/:id/messages    # 返回 subagent 的对话历史
GET  /api/v1/subagents/:id/stream      # SSE 实时推送（running 状态）
GET  /api/v1/subagent-batches          # 列出当前 session 的所有 batch
GET  /api/v1/subagent-batches/:batchId # batch 详情 + 所有 job 状态
POST /api/v1/subagent-batches/:batchId/cancel  # 取消整个 batch
POST /api/v1/subagents/:id/abort       # 中止单个 subagent
```

**数据来源**:
- 活跃 subagent: `subagentRegistry` 内存 Map + goroutine 的实时消息流
- 已完成 subagent: `workspace/sessions/subagent_{id}.json` state file
- 状态: 复用 `subagentRegistry.agents` / `.results` / `.summaries`

**实现文件**:
- [x] `internal/server/routes.go` — 注册新路由
- [x] `internal/server/handler_subagent.go` — handler 实现
- [x] `internal/agent/tools_subagent.go` — 暴露查询接口给 handler（目前 registry 是 package-level var）

### 1.2 Advisor 端点

```
POST /api/v1/advisor    # one-shot completion，接收 { model, messages, system_prompt, thinking_level }
```

- [x] `internal/server/handler_advisor.go` — 复用 `llm-proxy` 的 provider 调用逻辑
- [x] `internal/agent/tools_advisor.go` — 注册 `advisor` tool 到 agent tool registry
- [x] `internal/config/config.go` — `[advisor]` section（model、api_key、base_url、effort）
- [x] `agentd.toml.example` — 加 advisor 配置模板

### 1.3 Checkpoint/Rewind

```
POST /api/v1/checkpoints              # 创建 checkpoint（沙箱内 git）
GET  /api/v1/checkpoints              # 列出 checkpoints
POST /api/v1/checkpoints/:id/restore  # 恢复
```

- [x] `internal/agent/tools_checkpoint.go` — checkpoint tool（沙箱内 git snapshot）
- [x] 自动 checkpoint: agent loop 的 turn_end 后触发（配置开关 `[checkpoint].auto = true`）

---

## Phase 2: Web 后端 — 代理 API + 前端数据

Web 后端不直接管 subagent 执行，但需要：
1. 代理 agentd 的查询 API 给前端用
2. 从 DB 补充 agentd 不在线时的历史数据

### 2.1 代理端点

```
GET /api/cli/subagent/:subagentId          # 代理 → agentd /api/v1/subagents/:id/messages
GET /api/cli/subagent/:subagentId/stream   # 代理 → agentd SSE
GET /api/cli/subagent-batch/:batchId       # 代理 → agentd 或 fallback 查 DB
```

- [x] `app/api/cli/subagent/[subagentId]/route.ts`
- [x] `app/api/cli/subagent/[subagentId]/stream/route.ts`
- [x] `app/api/cli/subagent-batch/[batchId]/route.ts`
- [x] 鉴权: 复用 session auth，校验 subagent 属于当前用户

### 2.2 Web 前端端点（给 React UI 用）

```
GET /api/subagent/:subagentId/messages     # 前端 fetch
```

- [x] `app/api/subagent/[subagentId]/messages/route.ts` — 先查 agentd（如果在线），fallback 查 DB

---

## Phase 3: Web 前端 — React UI

### 3.1 Batch 卡片组件

在主聊天流中，收到 `subagent-batch-event` type=spawned 时插入：

```
┌─ Subagent Batch ─────────────────────────────────┐
│ ● agent-1: Researching API docs      [running]   │
│ ● agent-2: Writing unit tests        [running]   │
│ ✓ agent-3: Reviewing PR comments     [completed] │
│ ✗ agent-4: Deploying staging         [failed]    │
├──────────────────────────────────────────────────┤
│ 4 agents · 1 complete · 1 failed · 2 running     │
└──────────────────────────────────────────────────┘
```

- [x] `components/chat/subagent-batch-card.tsx` — batch 卡片
- [x] `components/chat/subagent-job-row.tsx` — 单个 job 行（spinner / 状态色）
- [x] 点击 job → 打开 subagent 详情页

### 3.2 Subagent 详情页

点击后打开新页面（或侧边面板），显示该 subagent 的完整对话流：

```
URL: /chat/:sessionId/subagent/:subagentId
```

- [x] `app/chat/[sessionId]/subagent/[subagentId]/page.tsx`
- [x] 复用现有 message rendering 组件（user / assistant / tool call blocks）
- [x] 只读（不能向 subagent 发消息）
- [x] Running 时实时更新（SSE 或轮询）

---

## Phase 4: CLI Adapter + Desktop

### 4.1 CLI Adapter

- [x] `packages/agentboster-adapter/src/subagent.ts`:
  - `fetchSubagentMessages(baseUrl, token, subagentId)` → agentd 或 web 后端
  - `fetchSubagentBatch(baseUrl, token, batchId)` → batch 概览
  - `streamSubagentMessages(baseUrl, token, subagentId)` → SSE EventSource
- [x] 导出到 `@agentboster/adapter` index.ts

### 4.2 Desktop — Subagent 事件 UI

在 `chat-view.ts` 的 `handleEvent` 中识别 `workflow.subagent` custom message：

- [x] 渲染为可点击的状态行（类似 workflow-view 但专门化）:
  - `started` → spinner + 蓝色 "Subagent executing: {task}"
  - `completed` → 绿色 ✓ + summary 预览
  - `failed` → 红色 ✗ + error
- [x] Batch event (`workflow.subagent.batch`) 渲染为分组标题

### 4.3 Desktop — Subagent 详情窗口

点击 subagent 行 → 打开新 session tab（只读）：

- [x] 用 `createSessionTab` 创建新 tab，标题 "Subagent: {name}"
- [x] tab 内容：调用 `fetchSubagentMessages` 拉取 messages
- [x] 复用 `chat-view` 的 message rendering（text + tool calls + thinking）
- [x] Running 时: `streamSubagentMessages` SSE 实时更新
- [x] 只读标记: composer 隐藏或禁用

### 4.4 CLI TUI 增强（可选）

- [x] `WorkflowSubagentMessageComponent` 加展开支持
- [x] 或用 `ctx.ui.custom()` 打开全屏详情

---

## Phase 5: agentd 独立增强（不依赖 UI 层）

### 5.1 Sequential Thinking

- [x] `internal/agent/tools_thinking.go` — 注册 process_thought / sequential_think
- [x] 存储在 workspace 目录下，主 agent 和 subagent 共享

### 5.2 Web Search 增强

- [x] 搜索结果缓存（`internal/cache/` 扩展）
- [x] 搜索历史追踪（让 agent 知道搜过什么）

### 5.3 MCP Server 管理 API

```
GET    /api/v1/mcp-servers
POST   /api/v1/mcp-servers
DELETE /api/v1/mcp-servers/:id
```

### 5.4 Metrics 增强

- [x] per-subagent token 消耗
- [x] tool 执行时间 P50/P95/P99
- [x] Prometheus 格式导出

---

## 数据流全景

```
agentd (Go daemon)
├── subagentRegistry (内存: 活跃 subagent 状态)
├── workspace/sessions/subagent_{id}.json (磁盘: 已完成)
├── GET /api/v1/subagents/:id/messages ←── Phase 1
├── GET /api/v1/subagents/:id/stream ←──── Phase 1
└── POST /api/v1/advisor ←───────────────── Phase 1
        │
Web Backend (Next.js)
├── DB: agent_subagent_jobs / batches
├── SSE: subagent-event → CLI / Desktop
├── GET /api/cli/subagent/:id ←──────────── Phase 2 (代理 agentd)
└── GET /api/subagent/:id/messages ←──────── Phase 2 (给 React UI)
        │
        ├── Web Frontend (React)
        │   ├── batch card in chat flow ←── Phase 3
        │   └── /chat/:sid/subagent/:id ←── Phase 3 (详情页)
        │
        ├── CLI Adapter (TS)
        │   └── fetchSubagentMessages() ←── Phase 4
        │
        └── Desktop (Tauri + Lit)
            ├── subagent status line ←────── Phase 4 (chat-view)
            └── new tab: subagent detail ←── Phase 4 (只读 session)
```

## 注意事项

- Subagent messages 可能很大，需要分页或 lazy loading
- SSE 连接数: 每个 running subagent 一个 SSE → 考虑合并成单个多路复用 SSE
- agentd 不在线时: fallback 到 DB 的 `agent_subagent_jobs` 表（只有状态，没有 messages）
- Desktop 新 tab 是只读的
- 鉴权: 确保用户只能查看自己 session 下的 subagent
