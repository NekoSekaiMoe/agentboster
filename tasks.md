好，这份文档覆盖你刚才讨论的所有设计决策，只写类型定义和接口定义。

---

## AgentClaw 多节点智能调度设计

### 1. 单机单实例检测

Agent Daemon 启动时检查 PID 文件 `/var/run/agentd.pid`，防止同机重复启动。

```
类型定义：

PIDFile {
    PID       int       // 进程 ID
	    StartTime time.Time // 启动时间
		    Port      int       // 监听端口
			}
			```
			
			行为：
			- PID 文件不存在 → 正常启动，写入 PID 文件
			- PID 文件存在 + 进程存活 → 拒绝启动，退出码 1
			- PID 文件存在 + 进程不存在 → 覆盖 PID 文件，正常启动（上次异常退出）
			
			---
			
			### 2. 节点注册
			
			Agent Daemon 启动完成后调 ClawLess API 注册自身。
			
			```
			POST /api/agentd/v1/nodes/register
			
			请求：
			NodeRegisterRequest {
			    NodeID     string   // 节点唯一 ID，首次注册时为空，由 ClawLess 分配
				    IP         string   // 节点 IP
					    Port       int      // 监听端口
						    Sandboxes  []string // 支持的沙箱类型 ["tmpfs", "chroot", "docker"]
							    Version    string   // Agent Daemon 版本
								}
								
								响应：
								NodeRegisterResponse {
								    NodeID   string // 分配或返回已有节点 ID
									    Interval int    // 心跳间隔（秒），默认 30
										}
										```
										
										节点 ID 由 ClawLess 分配，Agent Daemon 持久化到本地 `/var/run/agentd.node_id`，后续心跳复用。
										
										---
										
										### 3. 心跳上报
										
										Agent Daemon 定期上报自身负载指标。
										
										```
										POST /api/agentd/v1/nodes/heartbeat
										
										请求：
										HeartbeatRequest {
										    NodeID      string
											    CPUUsage    float64 // CPU 使用率 0.0-1.0（1 分钟 loadavg / 核心数）
												    MemAvail    float64 // 内存可用率 0.0-1.0（MemAvailable / MemTotal）
													    DiskAvail   float64 // 沙箱目录所在分区可用率 0.0-1.0
														    ActiveTasks int     // 当前活跃任务数
															    ActiveSandboxes int // 当前活跃沙箱数
																    Timestamp   time.Time
																	}
																	
																	响应：
																	HeartbeatResponse {
																	    Accepted bool
																		}
																		```
																		
																		指标采集方式：
																		- CPUUsage：`/proc/loadavg` 1 分钟负载 / `runtime.NumCPU()`
																		- MemAvail：`/proc/meminfo` 读取 MemAvailable / MemTotal
																		- DiskAvail：沙箱目录所在分区的可用空间 / 总空间
																		
																		---
																		
																		### 4. ClawLess 端存储
																		
																		```
																		agentd_nodes 表（Neon Postgres）：
																		
																		AgentNode {
																		    NodeID      string
																			    IP          string
																				    Port        int
																					    Sandboxes   []string
																						    Version     string
																							    Status      string   // "online" | "offline"
																								    CPUUsage    float64  // 最近一次心跳
																									    MemAvail    float64
																										    DiskAvail   float64
																											    ActiveTasks int
																												    LastHeartbeat time.Time
																													    RegisteredAt  time.Time
																														}
																														```
																														
																														心跳更新策略：
																														- 每次心跳更新 CPUUsage / MemAvail / DiskAvail / ActiveTasks / LastHeartbeat
																														- 超过 2 分钟无心跳 → Status 标记为 "offline"
																														- 离线节点不分配新任务，已有任务继续运行（Agent Daemon 可能只是网络问题）
																														
																														---
																														
																														### 5. 智能调度
																														
																														ClawLess 分配任务时选择最优节点。
																														
																														```
																														调度策略：
																														
																														NodeSelector {
																														    // 筛选可用节点
																															    Filter(nodes []AgentNode) []AgentNode
																																    // 计算综合得分
																																	    Score(node AgentNode) float64
																																		    // 选择得分最高的节点
																																			    Select(nodes []AgentNode) AgentNode
																																				}
																																				```
																																				
																																				筛选条件：
																																				- Status = "online"
																																				- 支持任务所需的沙箱类型
																																				- CPUUsage < 0.9 AND MemAvail > 0.1 AND DiskAvail > 0.1
																																				
																																				综合得分公式：
																																				```
																																				Score = (1 - CPUUsage) × 0.4 + MemAvail × 0.4 + DiskAvail × 0.2
																																				```
																																				
																																				- CPU 和内存各 40%（任务多为 CPU/内存密集型）
																																				- 磁盘 20%（tmpfs 用内存，chroot 项目文件通常不大）
																																				- 得分最高者被选中
																																				- 得分相同时选 ActiveTasks 最少的
																																				
																																				任一指标低于 10% → 即使满足筛选条件也不分配新任务（防止任务启动后立即失败）。
																																				
																																				---
																																				
																																				### 6. 前端节点状态面板
																																				
																																				ClawLess Web UI 的 `/config/agent-daemon` 页面展示节点列表。
																																				
																																				```
																																				节点状态面板数据结构：
																																				
																																				NodeStatusPanel {
																																				    Nodes []NodeStatusItem
																																					}
																																					
																																					NodeStatusItem {
																																					    NodeID       string
																																						    Status       string   // 在线/离线
																																							    CPUBar       float64  // CPU 使用率，前端渲染为进度条
																																								    MemBar       float64  // 内存可用率
																																									    DiskBar      float64  // 磁盘可用率
																																										    Score        float64  // 综合得分
																																											    ActiveTasks  int
																																												    Sandboxes    []string
																																													    LastHeartbeat string // 相对时间 "15 秒前"
																																														}
																																														```
																																														
																																														前端数据来源：`GET /api/agentd/v1/nodes/status`，ClawLess 从 `agentd_nodes` 表聚合返回。
																																														
																																														---
																																														
																																														### 7. Agent Daemon 端新增接口
																																														
																																														Agent Daemon 不需要新增对外接口。节点注册和心跳是 Agent Daemon 内部定时器自动完成，不暴露为 HTTP 端点。
																																														
																																														Agent Daemon 配置新增字段（agentd.toml）：
																																														
																																														```
																																														[node]
																																														id_file = "/var/run/agentd.node_id"
																																														
																																														[clawless]
																																														heartbeat_interval = 30  // 秒
																																														```
																																														
																																														---
																																														
																																														### 总结
																																														
																																														所有新增逻辑全在 ClawLess 端——节点选择、得分计算、状态面板。Agent Daemon 只多做了三件事：启动时检查 PID 文件、启动后调注册 API、定期报心跳。保持 Agent Daemon 的无状态性，调度智能全在云端。
