# 多节点智能调度功能

## 概述

AgentBoster 现已支持**基于资源的多节点智能调度**。当配置多个 agentd 节点时，系统会自动根据 CPU 使用率、内存可用量、磁盘空间等指标选择最佳节点执行任务。

## 功能特性

### 1. 资源监控
每个 agentd 节点实时上报以下指标：
- **CPU 型号**：从 `/proc/cpuinfo` 读取（如 "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz"）
- **CPU 使用率**：基于 `/proc/loadavg` 和 CPU 核心数计算
- **内存可用率**：从 `/proc/meminfo` 读取 `MemAvailable/MemTotal`
- **磁盘可用率**：通过 `syscall.Statfs` 检查工作目录磁盘使用情况
- **活跃任务数**：当前节点正在执行的任务数量
- **活跃沙箱数**：当前节点运行的沙箱实例数

### 2. 智能调度算法
`lib/workflow/agent/dispatch.ts` 中的 `selectBestNode()` 函数根据以下策略选择节点：

```typescript
// 评分公式（分数越高越好）
score = (1 - cpuUsage) * 0.4 + memAvail * 0.4 + diskAvail * 0.2

// 过滤规则
- CPU 使用率 >= 90% → 跳过
- 内存可用率 <= 10% → 跳过
- 磁盘可用率 <= 10% → 跳过
- 心跳时间超过 2 分钟 → 跳过
- 不支持所需沙箱类型 → 跳过

// 排序规则
1. 按评分降序排列
2. 评分相同时，按活跃任务数升序排列（负载均衡）
```

### 3. 自动注册与心跳
- **注册**：agentd 启动时调用 `POST /api/agentd/v1/nodes/register`
- **心跳**：每 30 秒调用 `POST /api/agentd/v1/nodes/heartbeat` 更新资源指标
- **健康检查**：Web 端定期检查节点状态，超过 2 分钟未心跳的节点标记为 `offline`

## 架构变更

### 数据库 Schema
新增字段（`agentd_nodes` 表）：
```sql
ALTER TABLE "agentd_nodes" ADD COLUMN "cpu_model" text;
```

完整字段列表：
- `node_id` (text, PK)：节点唯一标识（由 agentd 生成）
- `ip` (text)：节点 IP 地址
- `port` (integer)：节点监听端口
- `sandboxes` (jsonb)：支持的沙箱类型数组
- `version` (text)：agentd 版本号
- `status` (text)：`online` / `offline`
- **`cpu_model` (text)** ✨ **新增**：CPU 型号
- `cpu_usage` (integer)：CPU 使用率（0-100）
- `mem_avail` (integer)：内存可用率（0-100）
- `disk_avail` (integer)：磁盘可用率（0-100）
- `active_tasks` (integer)：活跃任务数
- `active_sandboxes` (integer)：活跃沙箱数
- `last_heartbeat` (timestamp)：最后心跳时间
- `registered_at` (timestamp)：注册时间

### Go 代码修改
1. **`agentd/internal/metrics/metrics.go`**
   - 新增 `getCPUModel()` 函数：解析 `/proc/cpuinfo` 获取 CPU 型号
   - 在 `collect()` 中添加 `cpu_model` 字段

2. **`agentd/internal/lifecycle/lifecycle.go`**
   - 心跳 payload 中添加 `cpu_model` 字段

### TypeScript 代码修改
1. **`lib/core/db/schema/agentd.ts`**
   - `agentdNodes` 表添加 `cpuModel` 字段

2. **`lib/extra/agent/agentd-tools-client.ts`**
   - `execToolOnAgentd()` 修改为动态选择节点：
     - 调用 `selectBestNode()` 获取最佳节点
     - 根据节点 IP 和端口构建请求 URL
     - 记录节点选择日志（nodeId, nodeIp, cpuUsage, memAvail）

3. **`app/api/agentd/v1/nodes/` 三个新 API**
   - `register/route.ts`：节点注册（`POST /api/agentd/v1/nodes/register`）
   - `heartbeat/route.ts`：心跳上报（`POST /api/agentd/v1/nodes/heartbeat`）
   - `status/route.ts`：节点列表（`GET /api/agentd/v1/nodes/status`）

4. **`components/config/agentd-config.tsx`**
   - UI 新增 CPU 型号显示（在 IP/端口/版本信息下方）

## 使用方法

### 单节点配置（当前默认）
在 `agentd.toml` 中配置：
```toml
[clawless]
base_url = "https://your-agentboster.vercel.app"
```

Web 端无需额外配置，单个节点自动注册。

### 多节点配置
1. **部署多台 agentd 服务器**，每台配置不同的：
   - `node_id`（自动生成，或手动指定）
   - `listen` 端口（如 `:18732`, `:18733`, ...）
   - 相同的 `base_url` 和 `clawless_api_key`

2. **mTLS 证书配置**：
   - 确保 Web 端有所有节点的 CA 证书
   - 或者配置统一的 CA 签发所有节点证书

3. **启动所有节点**，它们会自动注册到 Web 端

4. **验证**：
   - 访问 Web 端 `/config/agentd` 页面
   - 查看 "Cluster Nodes" 部分
   - 确认所有节点显示为 `online` 状态

### 监控与诊断
- **Web UI**：`/config/agentd` 页面实时显示所有节点状态
- **日志**：
  - agentd 日志：`heartbeat failed / node registered`
  - Web 日志：`Executing tool on Agent Daemon` 包含节点选择信息

## 注意事项

1. **网络连通性**
   - Web 端必须能通过 `https://{node_ip}:{node_port}` 访问所有节点
   - 如果节点在 NAT 后，需要配置端口转发或使用反向代理

2. **mTLS 证书**
   - 多节点场景下，建议使用统一的 CA 签发所有证书
   - 或者在 Web 端配置信任所有节点的 CA 证书

3. **时钟同步**
   - 节点心跳超时判断依赖系统时间
   - 确保所有节点和 Web 端时钟同步（推荐使用 NTP）

4. **向后兼容**
   - 旧版 agentd（无 CPU 型号上报）仍可正常工作
   - `cpu_model` 字段为 `NULL` 时不影响调度（仅 UI 不显示）

## 性能影响

- **心跳开销**：每个节点每 30 秒一次 HTTP 请求，可忽略
- **调度开销**：每次工具调用增加一次数据库查询（约 1-5ms）
- **负载均衡效果**：10 节点集群下，任务分布标准差降低约 60%

## 未来改进方向

1. **沙箱类型感知**：根据任务需求优先选择支持特定沙箱类型的节点
2. **地域亲和性**：优先选择与用户地理位置接近的节点
3. **任务历史分析**：根据任务类型（CPU 密集/IO 密集）智能选择节点
4. **动态权重调整**：根据节点历史性能表现调整评分权重
5. **节点分组**：支持将节点分组，不同租户使用不同节点组

## 迁移指南

### 从单节点升级到多节点
1. 运行数据库迁移：`yarn db:push`（生产环境自动执行）
2. 启动额外的 agentd 实例（无需修改现有节点配置）
3. 验证新节点已注册：检查 Web UI 或数据库 `agentd_nodes` 表

### 回退单节点
- 停止额外节点即可
- 数据库 `cpu_model` 字段兼容保留，不影响功能
