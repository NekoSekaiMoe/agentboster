四个 IM 平台（Telegram、Discord、Slack、飞书）的通知功能复用 Asika 的两层设计，但不复用 Asika 的 Bot 层代码（Asika 用 Go，ClawLess 用 TypeScript）。复用的是**架构模式和消息路由逻辑**。

---

## 复用 Asika 的架构模式

Asika 的通知系统有两层，直接映射到 AgentClaw：

| Asika 原有 | AgentClaw 对应 | 说明 |
|------|------|------|
| **9 个通知渠道 + 故障告警** | 4 个 IM 渠道 + Webhook 回调 | Asika 每个通知渠道独立实现，AgentClaw 同样每个 IM 渠道独立 Channel 类 |
| **分级上报（Escalation Worker）** | L2 超时升级 + 任务失败升级 | Asika 的 Escalation Worker 按优先级逐级通知 reviewer → team → tech lead，AgentClaw 按事件类型通知用户 |
| **故障告警（渠道连续失败 3 次自动切换）** | IM 渠道健康检查 + 自动切换通知渠道 | Asika 的 Notify 层独立追踪每个渠道失败次数，AgentClaw 同样追踪每个 IM 渠道的送达状态 |

---

## 两类通知的复用方式

### 1. 决策通知（Decision Notification）

触发场景：L2 高风险操作需要用户确认、任务超时需要用户决策。

复用 Asika 的 **Webhook Retry Worker + 去重模式**：

- Asika 的 Webhook Handler 用 `delivery_id` 做幂等去重。AgentClaw 的决策通知用 `task_id + decision_id` 做幂等去重，防止同一条确认请求重复发送。
- Asika 的 Webhook Retry Worker 用指数退避重试失败的 webhook。AgentClaw 的决策通知同样：用户首选 IM 渠道发送确认消息 → 如果 N 分钟内未收到用户回复 → 自动切换到备用 IM 渠道重发 → 所有渠道都无响应 → 升级为任务超时，暂停任务并记录日志。
- Asika 的 Escalation Worker 按优先级逐级上报。AgentClaw 的 L2 超时同样：等待用户回复 → 超时 → 通过 ClawLess API 调多渠道通知 → 仍无响应 → 任务挂起，用户下次上线时在任意 IM 渠道回复即可恢复。

消息内容模板（JSON 格式，每个 Channel 类负责渲染为平台特定格式）：

```json
{
  "type": "decision",
    "task_id": "xxx",
	  "decision_id": "xxx",
	    "title": "⚠️ 高风险操作需要授权",
		  "body": "命令: rm -rf /workspace/cache\n风险评分: 0.85\n原因: 递归删除操作",
		    "options": ["once", "10min", "1hour", "1day", "always", "reject"],
			  "expires_at": "2026-05-24T15:30:00Z"
			  }
			  ```
			  
			  ### 2. 完成通知（Completion Notification）
			  
			  触发场景：任务执行完成、子 Agent 全部完成、任务失败、冲突升级。
			  
			  复用 Asika 的 **多渠道同步通知 + 分级上报** 模式：
			  
			  - Asika 的通知系统支持同时向多个渠道发送同一条通知（如同时发 Telegram 和邮件）。AgentClaw 的完成通知同样：任务完成后，通过 ClawLess API 向用户配置的所有 IM 渠道同时推送结果摘要。
			  - Asika 的通知渠道独立追踪失败次数。AgentClaw 同样：主推用户最活跃的 IM 渠道，如果该渠道连续 3 次发送失败 → 自动切换到下一个可用渠道 → 全部渠道失败 → 写入 ClawLess 的 `notifications` 表，用户下次打开 Web UI 时看到。
			  - Asika 的分级上报（reviewer → team → tech lead）。AgentClaw 的任务失败通知同样：先通知用户 → 用户 N 小时未查看 → 通过备用渠道再次通知 → 如果是子 Agent 冲突导致失败，通知内容附带冲突详情和主 Agent 的处理建议。
			  
			  消息内容模板：
			  
			  ```json
			  {
			    "type": "completion",
				  "task_id": "xxx",
				    "status": "completed",
					  "title": "✅ 任务完成",
					    "summary": "重构 user-service 完成，测试通过，已推送到 main 分支。耗时 12 分钟。",
						  "details": {
						      "sub_agents": 3,
							      "files_changed": 15,
								      "commits": 3,
									      "logs_url": "https://clawless.app/tasks/xxx/logs"
										    },
											  "channel_fallback": ["telegram", "discord"]
											  }
											  ```
											  
											  ---
											  
											  ## ClawLess 端实现要点
											  
											  四个 IM Channel 类（`FeishuChannel`、`TelegramChannel`、`DiscordChannel`、`SlackChannel`）统一实现 `NotificationChannel` 接口，放在 `lib/extra/channels/` 下。每个 Channel 类负责：
											  
											  1. **发送通知**：接收统一的 JSON 消息体，渲染为平台特定格式（Telegram 用 Markdown + Inline Keyboard、Slack 用 Block Kit、Discord 用 Embed、飞书用 Card 消息）。
											  2. **接收用户回复**：监听 Webhook，解析用户回复（L2 授权选项），回调 ClawLess API 的 `/api/agentd/v1/l2-confirm`。
											  3. **健康检查**：每个 Channel 独立追踪最近 N 次发送的成功/失败状态，供通知管理器做渠道切换决策。
											  
											  通知管理器（`lib/extra/channels/manager.ts`）负责：
											  - 用户首选项管理（用户配置的首选 IM 渠道和备用渠道）
											  - 渠道健康状态聚合（从每个 Channel 的健康检查汇总）
											  - 发送策略：首选渠道发送 → 超时未确认 → 备用渠道发送 → 全部失败 → 写入离线通知队列
											  - 去重：用 `task_id + notification_type` 在 Redis KV 中做幂等（Asika 的 delivery_id 模式）
											  - 重试：指数退避 1s/2s/4s/8s/16s，最多 5 次
											  
											  不需要给代码，实现时直接参考 Asika 的 `notify/` 目录的分层设计——每个渠道独立实现、通知管理器统一调度、故障自动切换、幂等去重——这四个模式照搬即可。
