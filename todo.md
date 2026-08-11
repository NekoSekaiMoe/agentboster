# TODO: `set_visibility` 级联写入原子化

来源：review.md nitpick（`app/api/workspaces/[id]/route.ts` 约 310-347 行）。分析确认属实，但因双驱动约束不能直接套 `db.transaction`，需按仓库既有原子写模式改造，单独立项。

## 问题

`app/api/workspaces/[id]/route.ts` 的 `set_visibility` 分支在转为 private 时顺序执行 4 个独立写操作，无任何原子性保证：

1. `setWorkspaceVisibility(id, next)` — 改 workspaces.visibility
2. `deleteLongTermMemoriesByWorkspaceId(id, { sharedOnly: true })` — 删共享记忆池
3. `db.update(sessions)` — 把该工作区 shared 会话重置为 private
4. `setWorkspaceSharedMemory(id, false)` — 强制关闭共享池开关

中途失败留下的部分状态都有实际危害：

- 1 成功但 3 失败 → 工作区已 private 但遗留 shared 会话，**重新公开时会静默再暴露**（正是 `lib/chat/session-access.ts` shared 分支 `visibility==='public'` 加固防御的状态——那道防线是兜底，不应作为唯一保障）；
- 2 成功但 4 失败 → 共享池已删但 `sharedMemoryEnabled` 仍为 true，重新公开后池为空但开关开着；
- 任一步失败 → 响应返回的 `data` 与实际持久化状态不一致。

## 关键约束（为什么不能直接包事务）

- **双驱动原子写 API 互不重叠**（见 `lib/core/db/atomic.ts` 头部注释）：
  - neon-http（Vercel）：只有 `db.batch([...])`（Neon HTTP 事务 API，单 Postgres 事务）；调 `db.transaction` 运行时抛 "No transactions support in neon-http driver"。
  - node-postgres（自托管）：只有 `db.transaction(callback)`；`db.batch` 在 `NodePgDatabase` 上是 `undefined`。
  - `db` 是 Proxy 单例、类型按 neon 声明，**TS 无法捕获用错 API**，必须运行时分支。
- **必须用 `atomicWriteMode()` 分支**。先例（照抄结构）：
  - `lib/core/db/memory/long-term.ts` `replaceLongTermMemoryChunks`（约 1104-1136 行）——最完整的 delete+insert 双分支样板；
  - `lib/core/db/usage.ts:147`、`lib/core/db/memory/session.ts:41`、`lib/extra/vault/index.ts:320`。
- **KV 操作不能进 DB 事务**：`deleteLongTermMemoriesByWorkspaceId` 内部会调 `bumpSharedMemoryVersion`（KV incr，`lib/core/db/memory/long-term.ts:727-729`）。需要拆分：DB 删除进原子块，KV bump 在块**提交成功后**执行。KV bump 失败是 fail-open（版本读失败只跳过共享缓存，DB recall 照常，见 `lib/memory/recall.ts`），时序上"先 DB 后 KV"可接受——反过来"先 KV 后 DB"则会在 DB 回滚时留下多余的版本 bump（仅代价一次缓存重建，也可接受，但前者更干净）。

## 实施方案

1. **下沉为 DAL 级联函数**：在 `lib/core/db/agentd.ts` 新增 `setWorkspaceVisibilityCascade(id, next)`，封装全部 DB 写：
   - neon 分支：`db.batch([updateWorkspaces, deleteSharedMemories, updateSessions, updateSharedMemoryToggle])`。batch 元素须为预先构建、无相互依赖的查询对象——当前 4 步互相不读对方结果（第 4 步的 `updated.sharedMemoryEnabled` 判断可改为无条件幂等写 `sharedMemoryEnabled=false`，语义等价：转 private 本就该关掉），因此满足 batch 约束。
   - pg 分支：`db.transaction(async (tx) => ...)`，全部写走 `tx`。
   - 保留 archived → 返回 null（route 映射 409）的语义：batch/事务内先 `UPDATE ... WHERE status='active' RETURNING`，无行则抛出/短路回滚。
2. **拆分 KV 与 DB**：给 `deleteLongTermMemoriesByWorkspaceId` 加一个可选 `skipVersionBump` 参数（或拆出纯删除的内部函数），cascade 内部调用时跳过 bump；route（或 cascade 尾部）在原子块成功后统一 `bumpSharedMemoryVersion(id)` 一次。注意保持 `long-term.shared-version.test.ts` 对默认行为（仍 bump）的覆盖不变。
3. **route 接入**：`set_visibility` 分支改为单次调用 cascade；响应 `data` 使用提交后的最终行（保留现有 "toggled 行优先" 的语义，避免 `sharedMemoryEnabled:true` 的陈旧响应）。
4. **测试**：
   - 现有 route/DAL 测试先跑一遍确认无回归（`yarn test`，关注 `lib/core/db/` 与 `app/api/workspaces` 相关用例）；
   - 新增用例：模拟级联中第 N 步失败（mock db 抛错），断言 workspaces/sessions/memories 全部保持原状（neon 分支 mock `db.batch` 抛错；pg 分支 mock `db.transaction` 回调抛错）；
   - 断言 KV bump 只在 DB 块成功后发生（spy 调用顺序）。
5. **验证门槛**：
   - `yarn check:lint`（tsc + biome）；
   - `yarn test` 全绿；
   - `yarn build` —— 虽然改的是 `lib/core/db/**`（正常不在 workflow bundle 可达范围内），按 AGENTS.md 惯例凡触及可能被 workflow 传递引用的文件都应跑 build 确认 bundler 不报错。

## 验收标准

- [ ] 级联任一步失败 → 全部回滚，数据库无部分状态；
- [ ] neon / pg 双驱动行为一致（两条分支都被测试覆盖）；
- [ ] KV 版本 bump 在 DB 提交后恰好执行一次，失败不影响 DB 结果；
- [ ] 转 private 后重新公开，shared 会话与共享池状态始终一致（无静默再暴露）；
- [ ] 响应 `data.sharedMemoryEnabled` 不再可能返回陈旧的 `true`；
- [ ] `yarn check:lint` / `yarn test` / `yarn build` 全部通过。

## 备注

- `session-access.ts` 的 `visibility==='public'` 防御门（已合入）继续保留——它是兜底，本任务消除的是产生"私有工作区遗留 shared 会话"数据的根源之一。
- 同类非原子级联在 `archive` / `hard_delete` 分支也可能存在，本任务可先只覆盖 `set_visibility`；若模式验证可行，再推广（届时更新本文件或另立项）。
