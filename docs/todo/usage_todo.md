# Usage 记账接线 TODO（原 todo.md Batch 7 / P0-D1）

> 来源：todo.md P0-D1 决策（✅ 已决策：接通），并经逐条代码验证修正（关键证据见下方「现状盘点」，均附仓库内文件:行号）。
> 每步完成后跑 `yarn check:lint && yarn test`；动 `lib/workflow/**` 必须再跑 `yarn build`。

## 现状盘点（已验证，注意与旧 todo 的出入）

**已完成的地基：**

- `task_usage` 表：`lib/core/db/schema/usage.ts:30`，UNIQUE `(task_id, provider, model)`；当前 `recordTaskUsage`（`lib/core/db/usage.ts:65`）使用增量 upsert，能避免重复行，但重试会再次累加，**尚不幂等**
- `SHARED_USER_SENTINEL = '__shared__'`：规避 NULL 绕过 unique index
- `node_usage_daily` rollup：pg transaction / neon batch 下原子写入
- session 级 token 追踪已活：`lib/workflow/agent/steps/persist.ts:215-224`（注意：是 `steps/persist.ts`，不是 `persist.ts`）写 `sessions.totalTokens` / `latestTokenUsage`
- `components/message.tsx` 已渲染 token-usage part 和 step-finish 的 token 数据
- `app/api/config/monitoring/` 目录已存在（含 `metrics/`、`nodes/`），作为读接口落点

**旧 todo 证据中的错误（别再引用）：**

- ❌ "status 路由展示 token"——无任何 status 路由返回 usage 字段；`totalTokens` 仅由 `app/api/auth/users/route.ts`、`app/api/cli/sessions/route.ts`、`app/api/sessions/[id]/export/route.ts` 返回
- ❌ "users-management.tsx 已展示 per-user token 总量"——`components/config/users-management.tsx:56` 只在类型里声明了 `totalTokens`，**从未渲染**
- ❌ "pricing 费率表不存在"——该证据已过时；`lib/ai/pricing.ts` 已有静态费率表和 `computeUsageCost`，但尚未接入 usage 写入与监控 API
- ❌ `lib/workflow/agent/after-response.ts` 文件不存在；afterResponse 机制实际在 `lib/workflow/agent/dispatch.ts` 宿主侧

**未接线确认**：`recordTaskUsage` 除自身和 `usage.test.ts` 外**零调用方**。

## 接线步骤

- [ ] **1. 写入侧接线与幂等**：在 `lib/workflow/agent/steps/persist.ts` 把 `step.usage` + taskId/userId/provider/model 穿进 `recordTaskUsage`；以稳定的 Workflow run ID + step number（agentd 上报则使用稳定 callback/event ID）作为 usage event 幂等键并持久化唯一约束。事务内先原子 `INSERT ... ON CONFLICT DO NOTHING` 接受事件，只有首次接受时才累加 `task_usage` / `node_usage_daily`；重试不得再次增加 token 或 cost。provider/model 从 step 上下文取。注意 workflow 树纪律：禁止顶层 `node:*` import
- [ ] **2. pricing 费率表对接**：`lib/ai/pricing.ts` 已有静态费率表与 `computeUsageCost(modelId, usage)`（未知模型返回 `null` 而非 0）。usage event 增加 `cost_source`（至少 `provider` / `estimate`）和费率版本元数据：provider 返回权威成本时记录 `provider`，否则已知模型可记录 `estimate`，未知 provider/model 保持 `costUsdTicks = null` 且无来源。聚合不得把权威值和估算值伪装成一个权威总额；分别保留两类 subtotal
- [ ] **3. 读接口**：新建 `app/api/config/monitoring/usage/route.ts`（复用 monitoring 区现有 session 鉴权模式），提供 per-model / per-user / per-day 聚合。响应显式返回 `currency: 'USD'`、`costUnit: 'usd_ticks_1e-10'` 和 UTC、首尾均包含的查询范围；分别返回 authoritative / estimated cost subtotal，展示总额为两者之和并带 `hasEstimatedCost` 标记。普通用户只能读取自己的 usage；管理员才能跨用户聚合；workspace 过滤必须校验访问权
- [ ] **4. UI**：monitoring 配置区加花费卡片，只消费 `/api/config/monitoring/usage`。`app/api/auth/users/route.ts` 仅在用户详情中返回逐 session 的 `totalTokens`，既不是 per-user 聚合，也没有模型、日期和成本语义，不得作为花费数据源
- [ ] **5.（可延后）`node_usage_daily` 第二阶段**：agentd 心跳附带 LLM usage 上报（Go 侧 + heartbeat 路由扩展）
- [ ] **6. 验证**：为 usage route 增加 session/user/workspace 隔离、日期聚合边界、authoritative/estimated 混合成本、重复 event 和 malformed response 测试；客户端响应必须通过 `parseWithFallback`。运行 `yarn check:lint && yarn test && yarn build`（动 workflow 树）及 `yarn db:generate`（如需迁移）；若实施 Step 5 的 agentd 变更，再运行 `go test ./...`、`go vet ./...`、`go build ./...` 和 `subpackage/sdk/scripts/regen-agentd.py`

## 备注

- 多用户方向已确认（users-management 存在），花费看板是自然延伸
- `lib/ai/presets.ts` 保留（D1 决策：接线时使用）
