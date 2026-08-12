# 软隔离记忆:工作空间/会话私有化不删除,便于再次公开后整合

> 状态:设计草案 · 关联需求:用户提出"工作空间/会话变私有只是分割记忆而不是删除,方便再次公开后整合"
> 相关代码:`lib/core/db/schema/agentd.ts` `setWorkspaceVisibilityCascade`、`lib/core/db/schema/memory.ts`、`lib/memory/dream/`

---

## 1. 背景与现状

### 1.1 当前行为(=问题所在)

`setWorkspaceVisibilityCascade(wsId, 'private')` 在一个原子事务里做四件事
(`lib/core/db/agentd.ts:1360-1464`):

1. `workspaces.visibility = 'private'`
2. `workspaces.sharedMemoryEnabled = false`
3. `sessions.visibility = 'shared' → 'private'`(批量 reset)
4. **物理 DELETE** `long_term_memories WHERE workspace_id=? AND shared=true`
   —— 共享池行被真正删除,附带 KV version bump

migration `0041_narrow_gorgon.sql` 的注释把这条路径标得很清楚:"converting a
workspace back to private — deletes the shared pool"。

### 1.2 为什么这是个问题

- **不可逆**:用户把工作空间临时转私有(比如临时收紧权限、做敏感任务),再转回
  public 时,共享记忆池已经空了,所有沉淀的团队知识归零。
- **与 Dream 矛盾**:`lib/memory/dream/` 已经有"合并、去重、归纳"能力,却没有
  "私有化冻结快照 → 再公开时复活 → Dream 合并"的衔接。
- **会话摘要同理**:`session_memories` 虽然靠 `sessions.onDelete: cascade`
  随会话存在,但会话 visibility 从 shared reset 为 private 时,该会话之前贡献
  给共享视图的摘要上下文也"消失"了(对其他成员而言)。

### 1.3 目标

> 私有化 = **软隔离(分割)**,不是删除。再公开 = **复活快照 + Dream 合并**。

用户已确认的取舍(见下文 §6 决策记录):
- 保留范围:共享池记忆(`shared=true`)+ 会话级摘要/上下文
- 再公开策略:**直接复活快照 + 跑 Dream 合并**(复用现有 dream 管线)
- 存储实现:**软隔离:加状态列,行不删**
- session visibility(shared→private)**同步改成隔离而非删除**

---

## 2. 设计

### 2.1 总体思路:复用 `dreamStatus` 软状态,不引入新删除

`long_term_memories.dream_status` 已有枚举
`['active','tentative','superseded','contradicted']`,recall 的 WHERE 子句已经
按 `dream_status='active'` 过滤(`buildWorkspaceVisibilityCondition` 上游)。本
方案**新增一个状态值 `quarantined`**,语义:

| 状态 | 含义 | recall 可见 | Dream 可见 |
|------|------|------------|-----------|
| `active` | 正常 | ✅ | ✅ |
| `tentative` | Dream phase2 新生,待 ratify | ❌ | ✅(includeInactive) |
| `superseded`/`contradicted` | Dream 归档 | ❌ | ✅(includeInactive) |
| **`quarantined`** *(新)* | 工作空间私有化时隔离的共享池行 | ❌ | ❌(默认) |

关键:**recall 已经会过滤非 active 行,所以加 `quarantined` 后,recall 天然不可
见——无需改 recall 查询。** Dream 默认也只看 active,所以隔离行不会被 Dream
误合并;再公开时显式带 `includeQuarantined` 把它们捞出来。

### 2.2 Schema 变更

**`long_term_memories`**(微改):

```ts
dreamStatus: text('dream_status', {
  enum: ['active', 'tentative', 'superseded', 'contradicted', 'quarantined'],
})
  .default('active')
  .notNull(),

/** 新增:隔离元数据。仅在 dream_status='quarantined' 时有意义。
 *  记录"何时被哪个工作空间的哪次私有化隔离",便于精准复活。 */
quarantineMeta: jsonb('quarantine_meta').$type<{
  workspaceId: string;
  isolatedAt: string;        // ISO 时间戳
  isolatedByRunId?: string;  // 触发私有化的 run(审计)
  originalDreamStatus: 'active' | 'tentative' | 'superseded' | 'contradicted';
  /** 复活后置位,标记已被某次再公开消费,避免重复复活 */
  restoredByRunId?: string;
  restoredAt?: string;
} | null>(),
```

为什么记 `originalDreamStatus`:私有化瞬间,共享池里可能混着 `active` 主行和
`superseded` 归档行。复活时应按原状态恢复,而不是一律变 active(否则会把已归档
的旧事实重新激活,污染记忆)。

**`session_memories`**(新增字段,同思路):

```ts
/** 会话级隔离。会话 visibility shared→private 时不删摘要,打此标记。
 *  会话 visibility 回到 shared 时清除。 */
quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
```

(用单独的时间戳列而非复用 dream_status,因为 `session_memories` 没有
dream_status 字段,且会话隔离语义独立。)

**`workspaces`**(新增审计字段):

```ts
/** 最近一次私有化隔离的版本号。每次 public→private +1。再公开时用它判断
 *  是否有待复活快照。 */
quarantineEpoch: integer('quarantine_epoch').default(0).notNull(),
```

### 2.3 私有化路径改造(`setWorkspaceVisibilityCascade`)

把第 4 步从 DELETE 改成 UPDATE:

```ts
// 旧:db.delete(longTermMemories).where(shared=true AND workspaceId=?)
// 新:
const now = new Date();
await tx
  .update(longTermMemories)
  .set({
    dreamStatus: 'quarantined',
    quarantineMeta: {
      workspaceId: id,
      isolatedAt: now.toISOString(),
      originalDreamStatus: <从原行读>,
    },
    updatedAt: now,
  })
  .where(
    and(
      eq(longTermMemories.workspaceId, id),
      eq(longTermMemories.shared, true),
      eq(longTermMemories.dreamStatus, 'active'),  // 只隔离 active 行
      activeGuard,
    ),
  );
```

会话侧同步:`sessions.visibility='shared'→'private'` 时,对每个被 reset 的
session,把其 `session_memories.quarantined_at = now`(保留行,不删)。

**KV version bump 行为不变**:仍然 `bumpSharedMemoryVersion(id)`,因为成员的缓存
必须失效——只是失效的原因从"行没了"变成"行隔离了",对读者透明。

### 2.4 再公开路径(public 时复活 + Dream 合并)

新增 `restoreQuarantinedMemories(workspaceId, runId)`:

```ts
// 1. 复活:把该 workspace 当前 epoch 的 quarantined 行翻回 active
await tx
  .update(longTermMemories)
  .set({
    dreamStatus: quarantineMeta.originalDreamStatus,  // 按原状态恢复
    quarantineMeta: { ...meta, restoredByRunId: runId, restoredAt: now },
    updatedAt: now,
  })
  .where(
    and(
      eq(longTermMemories.workspaceId, workspaceId),
      eq(longTermMemories.dreamStatus, 'quarantined'),
      // 只复活"本次私有化"隔离的行,不碰更早的历史
      sql`quarantine_meta->>'workspaceId' = ${workspaceId}`,
    ),
  );

// 2. 复活 session_memories
await tx
  .update(sessionMemories)
  .set({ quarantinedAt: null })
  .where(... session 属于该 workspace 且 quarantinedAt != null);

// 3. 把 workspaces.quarantine_epoch + 1(标记本轮快照已消费)
```

复活后,**触发一次定向 Dream 合并**。复用现有 `runDreamForUser`
(`lib/memory/dream/orchestrator.ts:92`),但需要扩展入参:

```ts
// 现状:runDreamForUser 只看 active 行
// 扩展:加 includeQuarantinedSince 选项,让 phase1/phase2 把刚复活的行纳入合并
await runDreamForUser({
  userId: ownerOf(workspaceId),
  config,
  scopeWorkspaceId: workspaceId,  // 新:限定单工作空间
  includeQuarantinedSince: lastPrivatizedAt,  // 新:只合并本轮复活的
});
```

合并的产物遵循 Dream 既有语义:重复的被 `superseded`、新归纳的是 `tentative`
→ ratify → `active`。**隔离-复活-合并全程零删除。**

### 2.5 recall 的过滤(无需改动,验证即可)

`buildWorkspaceVisibilityCondition` 只管 `shared OR user_id=?`,不直接管
`dream_status`。真正的 dream_status 过滤在 recall 的上游
(`listAllLongTermMemoryRows` 默认 `includeInactive=false`):
- 加了 `quarantined` 后,recall 默认看不到隔离行 ✅
- 再公开复活后 `dreamStatus` 翻回 `active`/`tentative`,recall 重新可见 ✅

唯一要补的:**`listAllLongTermMemoryRows` 的 `includeInactive` 文档要写清
`quarantined` 不被 `includeInactive=true` 隐式包含**——隔离行是"显式排除",
想看必须带 `includeQuarantined: true`(Dream 合并复活路径专用)。

---

## 3. 边界与不变量

1. **只隔离 active 行**:`tentative`/`superseded`/`contradicted` 行私有化时不
   动(它们本就不可见,隔离无意义);但若某 `superseded` 行的"原 active 主行"
   被隔离,复活时两者都回 `active` 会冲突。→ 解法:私有化时把同
   `(userId,projectId,key)` 的 superseded 链一起隔离,复活时一起恢复。

2. **多次私有化/公开(保留全部历史)**:`quarantineEpoch` 单调递增。每次
   私有化只隔离当时 active 的共享行;每次再公开只复活**未被消费过的**隔离行
   (`quarantineMeta.restoredByRunId IS NULL`)。被消费过的历史隔离行**保留在表
   里不删**,只是 recall 和默认 Dream 都不再看见它们(用
   `restoredByRunId IS NOT NULL` 区分)。这样支持审计与手动恢复;代价是表会增
   长,需要定期 GC(见 §3.1)。

3. **工作空间硬删除**:仍然真删除(含全部隔离行,无论是否被消费过)——隔离不
   是数据长生不老,只是"私有化不删"。

4. **跨用户**:共享池行 `userId` 是创建者。私有化/复活不影响 `userId`,只改
   `dreamStatus`。所以复活后该行仍归属原创建者,可见性仍由 `shared=true` 决定。

5. **会话摘要 vs 共享池**:`session_memories` 的隔离用独立字段
   `quarantinedAt`,不与 `long_term_memories.dreamStatus` 混用——两者生命周期
   不同(会话摘要随会话 cascade 删除,共享池行随工作空间)。

6. **隔离期信号冻结(已定)**:私有化瞬间冻结隔离行的 `recallCount` 和
   `lastRecalledAt`。隔离即不可 recall,信号不应衰减;复活后从冻结值继续累计。
   实现上由 recall 路径天然保证(recall WHERE 已排除 quarantined 行,自然不会
   bump 这些字段),无需额外快照——但要在 recall 代码注释里写明这条不变量,
   防止未来有人给 recall 加"全表扫描式信号更新"破坏它。

### 3.1 历史 epoch 的 GC(可选,后置)

由于决定保留全部历史,表会随私有化/公开次数线性增长。建议的 GC 策略(**本设计
不含实现,留给后续单独立项**):
- 只清理 `restoredByRunId IS NOT NULL` 且 `updatedAt` 早于阈值(如 90 天)的
  已消费历史隔离行;
- **绝不**清理 `restoredByRunId IS NULL` 的未消费隔离行(那是当前私有化正在
  保护的快照);
- GC 走独立后台任务,不阻塞私有化/复活热路径。

---

## 4. 落地步骤(建议顺序)

| 步 | 动作 | 文件 | 风险 |
|----|------|------|------|
| 1 | Schema 加字段 + 生成 migration | `lib/core/db/schema/memory.ts`、`schema/chat.ts`(session_memories)、`schema/agentd.ts`(workspaces.quarantineEpoch) | 低 |
| 2 | 改 `setWorkspaceVisibilityCascade`:DELETE→UPDATE quarantined | `lib/core/db/agentd.ts` | 中,需更新现有测试 `agentd.visibility-cascade.test.ts`(`shared-pool DELETE` 的断言改成 UPDATE) |
| 3 | 新增 `restoreQuarantinedMemories` + 接到 public 路径 | `lib/core/db/agentd.ts`、`app/api/workspaces/[id]/route.ts` | 中 |
| 4 | Dream orchestrator 加 `scopeWorkspaceId` + `includeQuarantinedSince` | `lib/memory/dream/orchestrator.ts`、`phase1-consolidate.ts`、`phase2-recombine.ts` | 中,需测合并不会把隔离行误当 active |
| 5 | recall/list 文档:明确 quarantined 的可见性边界 | `lib/core/db/memory/long-term.ts` | 低 |
| 6 | UI:再公开按钮加"恢复 N 条隔离记忆 + 合并中…"提示 | `components/...` | 低 |
| 7 | 审计日志:私有化/复活写 `agent_review_logs` 或专用 audit | `lib/core/db/schema/agentd.ts` | 低 |

---

## 5. 与 deer-flow 借鉴清单的关系

本设计**不依赖** deer-flow,但和那份清单的两条高度互补,建议一起排期:

- **🟡 记忆分类门(fail-closed)**:deer-flow 写事实前按
  scope/durability/authority 分类,fail-closed 拒绝越界写入。本设计的
  `quarantined` 是"事后隔离",分类门是"事前门禁"——两者一前一后,共同保证记忆
  边界清晰。建议在同一批落地。
- **🔴 Dream 合并管线**:本设计直接复用 agentboster 现有 Dream
  (phase1/phase2/ratify)。deer-flow 清单里没有比这更强的东西,所以本设计的
  "再公开整合"完全用 agentboster 自研能力,无需引入外部依赖。

---

## 6. 决策记录(用户已确认)

| 决策点 | 选择 | 备选 |
|--------|------|------|
| 保留范围 | 共享池 `shared=true` + 会话级摘要 | (未选)只保留共享池 |
| 再公开策略 | 复活快照 + Dream 合并 | (未选)保留快照不自动合并 / 实时 LLM 现场合并 |
| 存储实现 | 软隔离:加状态列,行不删 | (未选)物理迁移影子表 / workspace 快照表 |
| session visibility | 同步改成隔离而非删除 | (未选)只改工作空间共享池 |
| 隔离期信号 | **冻结** recallCount / lastRecalledAt | (未选)信号照常衰减 |
| 历史 epoch 保留 | **保留全部历史**,`restoredByRunId` 区分 | (未选)只留上一轮 / 只留最新 epoch |
| 合并等待期 UI | **Toast + 跳转 dream runs 页** | (未选)inline 进度条 / 静默后台合并 |

---

## 7. 已无待确认项

三个开工前待定点均已拍板(见 §6 后三行)。可以进入实现阶段。
