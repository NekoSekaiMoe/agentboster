AgentClaw 的“提问-回答”循环需要同时在 Web UI 和四个 IM 上运行。两者共享同一套决策逻辑，但交互方式完全不同。

复用 Asika 的 **事件驱动架构**：用户回复作为一个事件，通过 Event Bus 分发到等待中的 Worker，Worker 被唤醒后继续执行。Web 和 IM 只是事件来源不同，处理逻辑完全相同。

---

## 核心设计：统一决策事件模型

```
用户回复（Web 或 IM）
    │
	    ▼
		ClawLess API  /api/agentd/v1/l2-confirm
		    │
			    ▼
				决策事件 { task_id, decision_id, user_response, channel }
				    │
					    ▼
						Agent Daemon Event Bus → ReviewWorker 被唤醒 → 继续/取消任务
						```
						
						---
						
						## Web 端设计
						
						当 Agent 需要询问用户时，ClawLess Web UI 的 Chat 界面出现内联决策卡片，而不是纯文本消息。
						
						**复用 Asika 的 Dashboard 通知模式**：Asika 的 Web Dashboard 展示 PR 状态和需要操作的项目。AgentClaw 的 Web 端同样在 Chat 界面嵌入可操作的决策卡片，用户点击按钮后通过 API 回调 Agent Daemon。
						
						**具体设计**：
						
						| 场景 | Web UI 表现 | 用户操作 | 回调 |
						|------|-----------|--------|------|
						| L2 高风险确认 | 聊天框内出现决策卡片，显示命令、风险评分、原因，按钮：once/10min/1hour/1day/always/reject | 点击按钮 | POST `/api/agentd/v1/l2-confirm` |
						| 冲突解决选择 | 卡片显示冲突文件列表和两个版本，按钮：ours/theirs/manual | 点击按钮或手动编辑后提交 | POST 冲突解决结果 |
						| 任务分支决策 | 卡片显示两个方案对比，按钮：方案A/方案B/自定义 | 点击按钮或输入自定义指令 | POST 决策结果 |
						| 超时提醒 | 如果用户 N 分钟未操作，卡片变红，标题改为“等待您的决定” | 同上 | 同上 |
						
						Web 端无需管理超时重发——用户一直在浏览器前，如果离开会自动超时。但需在卡片上显示 **决策过期倒计时**，超时后卡片禁用按钮，显示“已超时，Agent 已暂停”。
						
						---
						
						## IM 端设计
						
						IM 端比 Web 端复杂，因为用户可能离线、消息可能乱序、一个用户可能有多个 IM 渠道。
						
						**复用 Asika 的多渠道通知 + 故障切换模式**：Asika 的通知系统按优先级选择渠道，失败后自动切换。AgentClaw 的提问通知同样——首选用户最活跃的 IM 发送，超时未回复切换到备用 IM，全部无响应则标记为离线。
						
						**具体设计**：
						
						| 场景 | IM 表现 | 用户操作 | 超时处理 |
						|------|--------|--------|---------|
						| L2 高风险确认 | 发送带按钮的消息（Telegram Inline Keyboard / Discord Buttons / Slack Block Actions / 飞书 Card）| 点击按钮，自动回复选项 | 3 分钟未回复→切换到备用 IM 重发→5 分钟全部无响应→任务挂起，用户上线后重新激活 |
						| 冲突解决选择 | 如果冲突简单，IM 按钮够用。如果复杂，发送摘要 + 引导用户打开 Web UI 查看详情 | 按钮或打开 Web | 同上 |
						| 任务分支决策 | 发送方案 A/B 对比 + 按钮 | 点击按钮 | 同上 |
						| 用户离线 | 所有 IM 无响应 | — | 任务挂起，状态 `waiting_user`。用户在任何 IM 上发消息即“上线”，Agent 重新发送待处理决策 |
						
						---
						
						## 消息去重与幂等
						
						**复用 Asika 的 Webhook 去重模式**：Asika 用 `delivery_id` 防止同一 webhook 重复处理。AgentClaw 用 `task_id + decision_id` 在 Redis KV 中做幂等。
						
						场景：同一个 L2 确认请求发到了 Telegram 和 Discord，用户在两个平台都点了按钮。Agent Daemon 收到两次回调，第一次处理并标记 `decision_id` 为已处理，第二次直接丢弃返回“已处理”。
						
						---
						
						## 决策队列管理
						
						用户可能同时有多个 Agent 在询问（主 Agent + 多个子 Agent 同时触发 L2）。需要决策队列防止用户在 IM 上被刷屏。
						
						**复用 Asika 的 Serial Queue 模式**：Asika 的 Serial Validation Worker 逐个处理队列项。AgentClaw 的用户决策队列同样——多个决策请求排队，一次只发一个给用户。用户回复后出队，发送下一个。
						
						但如果决策有关联（同一个任务链），允许并发决策（最多 3 个）。非关联决策串行发送。
						
						用户可以在任何 IM 上查看“待决策列表”（发送 `/decisions` 命令），选择处理哪个。
						
						---
						
						## 会话上下文保持
						
						**复用 Asika 的 Session 概念**：Asika 的每个 repo group 有独立配置。AgentClaw 的每个用户会话有独立决策上下文。
						
						当 Agent 向用户提问时，Agent Loop 的状态保存在 Agent Daemon 的会话缓存中（`/tmp/agentd/sessions/{session_id}.json`），包含：
						- 当前任务 ID
						- 等待的决策 ID
						- 决策类型和选项
						- 超时时间
						- 超时后的处理策略
						
						用户回复后，Agent Daemon 从缓存恢复 Agent Loop，继续执行。缓存中有上次暂停的完整上下文（工具调用历史、LLM 推理状态），Agent 无缝恢复。
						
						---
						
						## 总结
						
						Web 和 IM 的提问设计统一在三个模式上：
						
						1. **决策事件统一路由**：Web 点击和 IM 回复都走 `/api/agentd/v1/l2-confirm`，Agent Daemon 不感知渠道差异。
						2. **IM 渠道故障切换**：复用 Asika 的通知渠道健康检查 + 自动切换，用户首选 IM 无响应时自动切备用。
						3. **决策队列串行化**：复用 Asika 的 Serial Queue，多个决策排队发送，防止 IM 刷屏，但关联决策可并发。
						
						Web 端靠内联卡片 + 倒计时，IM 端靠按钮消息 + 多渠道自动切换 + 用户上线自动恢复。
