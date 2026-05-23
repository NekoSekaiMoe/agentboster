明白了。这个设计和之前讨论的 L2 时间窗口授权完全一致，但你现在把**会话边界**和**TTL 隔离**讲清楚了。

---

## AgentClaw 的 TTL 授权设计

### 会话边界定义

- **会话 = 一次独立的任务上下文**。用户在 IM 上发指令或 Web UI 上新建 Chat，自动创建一个 Session。
- 每个 Session 有独立的 `session_id`、独立的上下文、独立的记忆检索范围、**独立的 L2 授权缓存**。
- 用户可以通过前端切换会话，IM 上通过 `/session <id>` 或 `/session new` 切换。
- 会话之间完全隔离。Session A 里授权的 `always` 不会影响 Session B——即使两个会话是同一个用户、同一个 Agent。

### TTL 的自定义时间窗口

| 选项 | 含义 | 生效范围 |
|------|------|---------|
| **once** | 仅此次操作 | 单次命令 |
| **custom time** | 仅此次操作并在自定义时间内都遵循本次选择 | 范围时间内 |
| **always** | 本次会话内自动放行 | **仅当前 Session**，Session 结束（用户关闭/切换/删除）自动失效 |

### TTL 的隔离机制

```
用户 A，Session 1（重构 user-service）
    ├── L2 授权：always → Docker 操作
	    ├── TTL 缓存：Session 1 内存中，Docker 命令自动放行
		
		用户 A，Session 2（部署 payment-service）
		    ├── L2 授权：自定义时间(如一小时) → 修改 docker-compose.yml
			    ├── TTL 缓存：Session 2 内存中，docker-compose 操作 1 小时内放行
				    └── Session 1 的 always 授权**不影响** Session 2
					```
					
					Agent Daemon 的 `L2AuthCache` 结构：
					
					```go
					type L2AuthCache struct {
					    entries map[string]*L2AuthEntry  // key = session_id + command_pattern
						    mu      sync.RWMutex
							}
							
							type L2AuthEntry struct {
							    SessionID string
								    Pattern   string    // 命令模式（如 "docker*", "rm*"）
									    Window    string    // once / 10min / 1hour / 1day / always
										    ExpiresAt time.Time // 过期时间（always = Session 结束时间）
											}
											```
											
											### Worker 框架自动计时
											
											Agent Daemon 的 CleanupWorker（复用 Asika 的定时 Worker 模式）负责：
											
											1. **每 30 秒扫描** `L2AuthCache`，删除过期的 `L2AuthEntry`。
											2. **监听 Session 结束事件**：用户通过前端关闭会话、IM 上 `/session close`、或会话超时（配置的 `session_timeout`），Event Bus 发布 `session.closed` 事件 → CleanupWorker 清除该 Session 的所有 L2 授权缓存。
											3. **过期授权日志**：TTL 过期后，Agent Daemon 通过 ClawLess API 写入审查日志（`review_logs` 表），记录“L2 授权已过期：session_id=xxx, pattern=docker*, window=1hour”。
											
											### 会话数量限制
											
											- **默认保留最近 50 个会话**（可配置）。
											- 超过限制时，CleanupWorker 异步删除最老的会话：
											  1. 标记 Session 为 `archived`（Agent Daemon 内存 + ClawLess API）
											    2. 清除该 Session 的 L2 授权缓存（内存）
												  3. 删除本地 `/tmp/agentd/sessions/{session_id}.json`
												    4. 异步通知 ClawLess API 删除数据库中的会话记录和记忆（不阻塞 CleanupWorker）
													- 用户可以在前端设置保留数量（`session_max_count`），默认 50。
													
													### 前端切换会话
													
													**Web UI**：
													- `/chat` 页面左侧会话列表，点击切换。
													- 切换时，ClawLess API 通知 Agent Daemon：“用户切换到 Session X”。
													- Agent Daemon 保存当前 Session 的上下文（写入 `/tmp/agentd/sessions/{old_session_id}.json`），加载新 Session 的上下文。
													
													**IM**：
													- 用户发送 `/session list` → 列出最近 5 个会话（ID + 标题 + 创建时间）
													- 用户发送 `/session switch <id>` → 切换到指定会话
													- 用户发送 `/session new` → 创建新会话
													- 切换时，Agent Daemon 同样保存旧会话上下文，加载新会话。
													
													### 和 Manboster TTL 的差异
													
													| | Manboster | AgentClaw |
													|------|------|------|
													| **TTL 时长** | 固定，系统预设 | **用户自选**：once/10min/1hour/1day/always(会话) |
													| **always 范围** | 不明确 | **仅当前 Session**，Session 结束自动失效 |
													| **会话隔离** | 单会话，不需要隔离 | **多会话 TTL 完全隔离**，Session A 的 always 不影响 Session B |
													| **TTL 管理** | 未公开 | **Worker 框架自动计时**，CleanupWorker 每 30s 扫描过期授权 |
													| **会话数量** | 不适用 | **可配置上限**，超过自动删除最老会话（异步） |
													
													---
													
													这个设计明确了 TTL 的边界和生命周期管理，可以直接写入 Agent Daemon 的详细设计文档，指导 LLM 实现 `L2AuthManager` 和 `CleanupWorker`。
