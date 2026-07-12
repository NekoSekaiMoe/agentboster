# TODO: agentd 新功能规划

## 现有能力概览

agentd 是 Linux 执行平面，已有：
- **CodeAct 循环**: 完整的 agent loop + tool registry + context compaction
- **沙箱执行**: Docker/Docker-strict/LXC 三种隔离级别
- **安全**: L0(regex) → L1(scorer) → L2(用户确认) 三层防护
- **Subagent**: `subagent` + `subagent_result` tool，goroutine 并行执行，独立沙箱
- **Browser**: Playwright bridge（sandbox 内 unix socket）
- **LSP**: 自动检测项目类型 + 安装 language server + go-to-definition/hover/references
- **Web 工具**: web-fetch、web-search、rendered web fetch
- **Desktop**: VNC proxy（WebSocket 隧道到容器的 websockify）
- **LLM proxy**: `/api/v1/llm-proxy` 转发 LLM 请求
- **Session 管理**: 切换、关闭、状态查询、abort

## 可以新增的功能

### 1. Advisor 端点 — `POST /api/v1/advisor`

把 CLI 里的 advisor（直连 provider API 做 one-shot completion）下沉到 agentd。

**好处**:
- agentd 已有 `llm-proxy` 端点，可以复用 provider 配置
- API key 由 daemon 管理，CLI 不需要本地存 key
- agentd 的 CodeAct agent 也可以调用 advisor（不只是 CLI 用户）

**实现**:
- [ ] `internal/server/routes.go` 加 `v1.POST("/advisor", s.handleAdvisor)`
- [ ] `internal/agent/tools_advisor.go` — 注册 `advisor` tool 到 agent 的 tool registry
- [ ] advisor handler: 接收 `{ model, messages, system_prompt, thinking_level }`，调用 `llm-proxy` 或直连 provider
- [ ] 配置: `[advisor]` section in `agentd.toml`（model、api_key、base_url、effort）

### 2. Subagent Session 查询 — `GET /api/v1/subagents/:id/messages`

配合 TODO-subagent-viewer.md，让 desktop/web 能查看 subagent 的对话历史。

**实现**:
- [ ] 从 subagent 的 state file（`workspace/sessions/subagent_{id}.json`）读取消息
- [ ] 或从内存中的 `subagentRegistry` 读取活跃 subagent 的实时状态
- [ ] SSE 端点 `GET /api/v1/subagents/:id/stream` 实时推送 subagent 的 tool_execution 事件

### 3. Subagent Batch 管理

- [ ] `GET /api/v1/subagent-batches` — 列出当前 session 的所有 batch
- [ ] `GET /api/v1/subagent-batches/:batchId` — batch 详情（job 列表 + 状态）
- [ ] `POST /api/v1/subagent-batches/:batchId/cancel` — 取消整个 batch
- [ ] `POST /api/v1/subagents/:id/abort` — 中止单个 subagent

### 4. Checkpoint/Rewind 支持

把 pi-rewind 的 git checkpoint 能力下沉到 agentd（在沙箱内做）。

**好处**: 沙箱环境下的 git 操作比 CLI 本地操作更安全，不会影响主机 repo。

- [ ] `POST /api/v1/checkpoints` — 创建 checkpoint
- [ ] `GET /api/v1/checkpoints` — 列出 checkpoints
- [ ] `POST /api/v1/checkpoints/:id/restore` — 恢复到 checkpoint
- [ ] 自动 checkpoint: 在每个 turn_end 后自动创建（配置开关）

### 5. Sequential Thinking 持久化

agentd 的 subagent 可以使用 sequential thinking 来分解复杂任务。

- [ ] 在 agent 的 tool registry 中注册 `process_thought` / `sequential_think` 等 tools
- [ ] thinking session 存储在沙箱的 workspace 目录下
- [ ] 主 agent 和 subagent 共享 thinking 上下文（通过 file_boundaries 控制）

### 6. 增强的 Web Search

agentd 已有 `tools_web.go`（web-fetch）和 `tools_web_rendered.go`（Playwright rendered fetch）。可以增强：

- [ ] 搜索结果缓存（避免重复搜索同一个 query）
- [ ] 结构化搜索结果（JSON 格式，不只是文本）
- [ ] 搜索历史（让 agent 知道之前搜过什么）

### 7. MCP Server 管理

agentd 已有 `tools_mcp.go`。可以增强 MCP server 的生命周期管理：

- [ ] `GET /api/v1/mcp-servers` — 列出运行中的 MCP servers
- [ ] `POST /api/v1/mcp-servers` — 启动一个新的 MCP server
- [ ] `DELETE /api/v1/mcp-servers/:id` — 停止一个 MCP server
- [ ] 自动发现项目中的 `.mcp.json` 配置

### 8. Metrics + Observability

agentd 已有 `/metrics` 端点和 `internal/metrics/`。可以增强：

- [ ] 每个 subagent 的 token 消耗追踪
- [ ] tool 执行时间统计（P50/P95/P99）
- [ ] 沙箱资源使用（CPU/内存/磁盘）实时监控
- [ ] Prometheus 格式导出（替代当前的 JSON 文件）

## 优先级建议

1. **Advisor 端点**（#1）— 最直接，当前 CLI advisor 已经在跑，下沉到 agentd 让 daemon 端的 agent 也能用
2. **Subagent 查询**（#2 + #3）— 配合 subagent-viewer TODO，是 desktop/web UX 的关键缺失
3. **Checkpoint**（#4）— 安全网，对 agentd 的 CodeAct 循环特别重要（沙箱内操作可恢复）
4. 其余按需排
