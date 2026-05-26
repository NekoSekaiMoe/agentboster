只保留接口定义，更新提示词。这是 LLM 第一次读这份修正后的精简版。

---

## AgentClaw 长程记忆系统设计（修正版）

### 核心原则

**任务摘要是长程工作的唯一核心。** 不需要语义检索，不需要 embedding，不需要 pgvector。Agent 需要的是"这个任务做到哪一步了、上次的决策是什么、为什么做了这个决策"——精确的任务状态记录，不是模糊回忆。

---

### 任务摘要表

在 Neon Postgres 新增 `task_summaries` 表：

```
TaskSummary {
    task_id       string    // 任务唯一 ID
	    agent_id      string    // 所属 Agent
		    session_id    string    // 当前活跃会话 ID
			    status        string    // "active" | "paused" | "completed"
				    progress      string    // 当前进度描述（自由文本）
					    decisions     []Decision // 历史决策记录
						    pending       []string  // 待办事项列表
							    known_issues  []string  // 已知问题和注意事项
								    last_updated  time.Time
									    created_at    time.Time
										}
										
										Decision {
										    timestamp     time.Time
											    description   string    // 决策描述
												    reason        string    // 决策原因
													    alternatives  []string  // 考虑过的其他方案
														}
														```
														
														---
														
														### 摘要生命周期
														
														1. **任务开始时**：Agent Daemon 调 ClawLess API 获取任务摘要，注入 System Prompt 上下文
														2. **任务执行中**：Agent 调用 `task_progress` 工具更新进度和待办事项
														3. **任务结束时**：MemoryWorker 调 LLM 更新完整摘要——进度、决策、待办、已知问题
														4. **任务暂停时**：用户通过 IM 或 Web UI 暂停任务，摘要保存当前状态
														5. **任务恢复时**：Agent Daemon 加载摘要，Agent 从上次中断点继续
														
														---
														
														### 接口定义
														
														**ClawLess API 新增端点**：
														
														```
														GET /api/agentd/v1/tasks/:id/summary
														  返回: TaskSummary
														  
														  PUT /api/agentd/v1/tasks/:id/summary
														    请求: { progress?, decisions?, pending?, known_issues? }
															  返回: TaskSummary
															  
															  POST /api/agentd/v1/tasks/:id/summary/tidy
															    请求: 无
																  返回: TaskTidyReport
																    说明: 调 LLM 扫描摘要，生成整理建议（合并重复决策、清理已完成的待办事项、标记过时信息）
																	
																	PUT /api/agentd/v1/tasks/:id/summary/tidy/apply
																	  请求: { merge_ids?, delete_ids?, update_ids? }
																	    返回: { success: bool }
																		```
																		
																		**ToolRegistry 新增工具**：
																		
																		```
																		task_progress:
																		  参数: progress?, decision?, pending_add?, pending_done?, known_issue_add?, known_issue_resolve?
																		    返回: TaskSummary
																			  说明: Agent 在执行过程中主动更新摘要。LLM 在 System Prompt 中被告知"每次重要决策或进度变更时调用此工具"
																			  
																			  task_summary:
																			    参数: 无
																				  返回: TaskSummary
																				    说明: Agent 查看当前任务摘要
																					```
																					
																					---
																					
																					### 更新 System Prompt
																					
																					在 AgentClaw 的 System Prompt 中追加长程任务相关指令：
																					
																					```
																					## Long-Running Task Management
																					
																					You are executing a task that may span multiple sessions over days or weeks.
																					Your task summary is your only memory of what happened before this session.
																					
																					### When to Update Progress
																					Call `task_progress` whenever:
																					- You make a significant decision (choose between approaches, accept/reject a solution)
																					- You complete a milestone (a PR is merged, a dependency is updated)
																					- You encounter a blocker (test fails, need user input, waiting for external event)
																					- You discover a new known issue or resolve an existing one
																					
																					### When to Check Progress
																					Call `task_summary` at the start of each session to understand where you left off.
																					DO NOT rely on conversation history alone — your summary is authoritative.
																					
																					### Decision Recording
																					When recording a decision, always include:
																					- What you chose
																					- Why you chose it
																					- What alternatives you considered and why you rejected them
																					
																					This helps you (or a future instance of you) understand the context of past
																					decisions without re-analyzing the entire situation.
																					```
																					
																					---
																					
																					### 更新记忆提取提示词
																					
																					在 MemoryWorker 的提取提示词中区分短任务记忆和长程任务摘要：
																					
																					```
																					## Memory Extraction Rules
																					
																					### For Short Tasks (single session)
																					Extract key facts as before: project config, user preferences, historical decisions.
																					
																					### For Long-Running Tasks (spans multiple sessions)
																					DO NOT extract individual facts. Instead, update the task summary:
																					- Update progress based on what was accomplished this session
																					- Append new decisions to the decision history
																					- Update pending items: add new ones, remove completed ones
																					- Update known issues: add new ones, mark resolved ones
																					
																					The task summary is the single source of truth for long-running tasks.
																					Individual memory entries are for cross-task reference; the summary is for
																					continuing the same task.
																					```
																					
																					---
																					
																					### Agent Daemon 新增 Worker
																					
																					```
																					MemoryExtractWorker：
																					  触发条件：EventTaskCompleted 事件
																					    职责：
																						    1. 判断任务类型（短任务 vs 长程任务）
																							    2. 短任务：调 ClawLess API 提取关键事实，写入 memories 表
																								    3. 长程任务：调 ClawLess API 更新 task_summaries 表
																									
																									TaskTidyWorker：
																									  触发条件：定时器（配置的 tidy_interval，默认每周）
																									    职责：
																										    1. 扫描 task_summaries 表中所有 active 状态的摘要
																											    2. 调 LLM 判断摘要是否需要整理（重复决策合并、已完成的待办清理）
																												    3. 生成整理报告，通知用户审核
																													    4. 用户确认后执行整理
																														```
																														
																														---
																														
																														### 配置接口
																														
																														`agentd.toml` 中已有的 `[memory]` section 简化：
																														
																														```toml
																														[memory]
																														keyword_index = true        # 关键词索引（短任务记忆）
																														bm25_search = true          # BM25 全文检索（短任务记忆）
																														
																														[task_summary]
																														auto_update = true          # 每次任务结束后自动更新摘要
																														tidy_interval = "168h"      # 摘要整理间隔（默认每周）
																														max_decisions = 50          # 单个摘要最多保留的决策记录数
																														```
																														
																														---
																														
																														### 总结
																														
																														长程记忆系统的核心是 `task_summaries` 一张表。Agent 每次任务开始时加载摘要，执行中更新进度和决策，结束时 LLM 更新完整摘要。不需要语义检索，不需要 embedding，不需要 pgvector。任务摘要是长程工作的唯一记忆，精确、结构化、可直接注入上下文。
