# Usage 记账接线 TODO（原 todo.md Batch 7 / P0-D1）

> 来源：todo.md P0-D1 决策（✅ 已决策：接通），并经逐条代码验证修正（验证报告 `/tmp/verify/r5-routes-p0.md`）。
> 每步完成后跑 `yarn check:lint && yarn test`；动 `lib/workflow/**` 必须再跑 `yarn build`。

## 现状盘点（已验证，注意与旧 todo 的出入）

**已完成的地基：**

- `task_usage` 表：`lib/core/db/schema/usage.ts:30`，UNIQUE `(task_id, provider, model)`，幂等 `recordTaskUsage`（`lib/core/db/usage.ts:65`，`onConflictDoUpdate` 增量累加）
- `SHARED_USER_SENTINEL = '__shared__'`：规避 NULL 绕过 unique index
- `node_usage_daily` rollup：pg transaction / neon batch 下原子写入
- session 级 token 追踪已活：`lib/workflow/agent/steps/persist.ts:215-224`（注意：是 `steps/persist.ts`，不是 `persist.ts`）写 `sessions.totalTokens` / `latestTokenUsage`
- `components/message.tsx` 已渲染 token-usage part 和 step-finish 的 token 数据
- `app/api/config/monitoring/` 目录已存在（含 `metrics/`、`nodes/`），作为读接口落点

**旧 todo 证据中的错误（别再引用）：**

- ❌ "status 路由展示 token"——无任何 status 路由返回 usage 字段；`totalTokens` 仅由 `app/api/auth/users/route.ts`、`app/api/cli/sessions/route.ts`、`app/api/sessions/[id]/export/route.ts` 返回
- ❌ "users-management.tsx 已展示 per-user token 总量"——`components/config/users-management.tsx:56` 只在类型里声明了 `totalTokens`，**从未渲染**
- ❌ "pricing 费率表已完成"——**不存在**。只有注释里的 TODO（`usage.ts:18`、`schema/usage.ts:24,52,62`），需要从零实现
- ❌ `lib/workflow/agent/after-response.ts` 文件不存在；afterResponse 机制实际在 `lib/workflow/agent/dispatch.ts` 宿主侧

**未接线确认**：`recordTaskUsage` 除自身和 `usage.test.ts` 外**零调用方**。

## 接线步骤

- [ ] **1. 写入侧接线**：在 `lib/workflow/agent/steps/persist.ts`（或 dispatch.ts 的 afterResponse 队列）把 `step.usage` + taskId/userId/provider/model 穿进 `recordTaskUsage`（幂等 upsert，重复调用安全）；provider/model 从 step 上下文取。注意 workflow 树纪律：禁止顶层 `node:*` import
- [ ] **2. pricing 费率表（需新建）**：`lib/ai/pricing.ts` 不存在费率数据，需新建静态费率表 + `estimateCostUsdTicks(provider, model, tokens)`，对接 `usage.ts` 的 `costUsdTicks` 设计（无 authoritative cost 时估算）
- [ ] **3. 读接口**：新建 `app/api/config/monitoring/usage/route.ts`（复用 monitoring 区现有模式），per-model / per-user / per-day 聚合
- [ ] **4. UI**：monitoring 配置区加花费卡片。⚠️ 不能"复用 users-management 样式"的假设——该组件从未渲染 token，需新做展示；`app/api/auth/users/route.ts` 已返回 per-user `totalTokens`，可作为数据源
- [ ] **5.（可延后）`node_usage_daily` 第二阶段**：agentd 心跳附带 LLM usage 上报（Go 侧 + heartbeat 路由扩展）
- [ ] **6. 验证**：`yarn check:lint && yarn test && yarn build`（动 workflow 树）；`yarn db:generate` 如需迁移；跑 `subpackage/sdk/scripts/regen-agentd.py`（若动心跳协议）

## 备注

- 多用户方向已确认（users-management 存在），花费看板是自然延伸
- `lib/ai/presets.ts` 保留（D1 决策：接线时使用）
