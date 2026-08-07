# Memory Provider 统一化 · 取长补短迁移方案

> 对比源:`memoh` (Go, `internal/memory/`) vs `agentboster` (TS, `lib/memory/` + `lib/knowledge/`)
> 目标:吸收 memoh 的统一抽象层与 context packer,**保留** agentboster 现有的信任分级、Dream 巩固、零成本分流三大优势。

## 决策记录(2026-08-07 对齐)

| 决策点 | 选择 | 理由 |
|--------|------|------|
| **落地范围** | 全做 Phase 0-4(抽象 + registry + packer + MemoryVersion) | 地基与收益都重;Phase 5 外部 provider CRUD 延后 |
| **sourceKind 透传** | 所有 provider 强制遵守,不支持的原地走 `tool_observed` 兑底 | taint gate 是安全边界非可选优化;强制+最保守兑底把"忘记"变"显式拒绝",失败模式安全 |
| **缓存失效过渡** | 双轨过渡期(Phase 3 保留手动失效 + 新增 version,观察 2 周后 Phase 3.5 才删) | 避免 version 漏自增导致静默 stale;手动失效兼底 |
| **防漏 version 自增** | Write Gate 单一闸口 + 结构性防护(见 §1.5) | 把"靠纪律"提升为"靠结构",漏自增不可能静默发生 |

---

## 0. 现状诊断(为什么改)

### 分裂的两条线

```
lib/memory/   ← 内建记忆(long_term_memories + chunks + edges + dream)
                完全不实现任何 provider 接口
                被 context/index.ts 直接 import 调用

lib/knowledge/ ← 独立 RAG 文档库(knowledge_bases/documents/chunks/connectors)
                薄 registry:2 个 provider,仅 search 一个方法
                不参与自动注入,只能 agent 显式调工具
```

**后果**:
- 内建 vs 外部 adapter 各跑各的 RRF、各写各的 chunk 表(`long_term_memory_chunks` vs `knowledge_chunks`)
- 外部 adapter 只读(`search`),无法把记忆写回 mem0/http
- recall/trigger/profile/session/knowledge 五个来源在 context builder 里**手动拼接**(`context/index.ts` 230-282 行),无统一打包层
- 三套缓存(recallCache 进程 Map / triggerCache 进程 Map / profile Redis)靠 `cache-invalidation.ts` 手动串联,注释自承"DAL 旁路会致 stale"

### agentboster 必须保留的强项(重构中不得丢失)

| 能力 | 文件 | 为什么不能丢 |
|------|------|-------------|
| **`sourceKind` 信任分级 taint gate** | `extract.ts` / `profile.ts` / `dream/usage-signals.ts` | tool_observed 永不进 always-on profile、Dream boost 跳过、extractor 只降级 provenance —— prompt-injection 防护 |
| **Dream 三阶段 + 变异预算** | `dream/orchestrator.ts` + `phase3-sanitize.ts` | read/decide/write 分离,≤25% 退役上限 + delete preimage 审计,可回滚 |
| **trigger phrase / recall-intent 零成本分流** | `triggers.ts` / `recall-intent.ts` | 纯正则 + n-gram 覆盖率,避免每轮付宽检索成本 |

---

## 1. 目标架构

### 1.1 分层(借鉴 memoh 的三层分工)

```
┌─────────────────────────────────────────────────────────┐
│  Context Builder (lib/workflow/agent/context/)          │
│  只认 MemoryProvider + ContextPacker,不直接 import 任何 │
│  具体 recall/trigger/profile 实现                       │
└──────────────────────────┬──────────────────────────────┘
                           │ 统一接口
┌──────────────────────────┴──────────────────────────────┐
│  MemoryProvider 接口 + Capability 接口(新)             │
│  + Registry(新,per-user/per-scope 缓存实例)           │
└──────────────────────────┬──────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────▼──────┐  ┌────────▼────────┐ ┌────────▼────────┐
│ Builtin      │  │ Mem0Provider    │ │ HttpProvider    │
│ (现有 memory)│  │ (扩自 knowledge)│ │ (扩自 knowledge)│
│              │  │                 │ │                 │
│ 实现:        │  │ 实现:           │ │ 实现:           │
│ - Provider   │  │ - Provider      │ │ - Provider      │
│ - Compact    │  │ (CRUD 全实现,   │ │ (CRUD 全实现)   │
│ - SourceSync │  │  不再 disabled) │ │                 │
│ - Ingest     │  │                 │ │                 │
│ taint gate ✓ │  │                 │ │                 │
└──────────────┘  └─────────────────┘ └─────────────────┘
```

### 1.2 核心接口设计(借鉴 memoh 的"窄主接口 + opt-in 能力接口")

```ts
// lib/memory/provider/types.ts(新建)

/**
 * 统一记忆接口 —— 所有后端(builtin / mem0 / http / 未来)实现同一个。
 * 借鉴 memoh provider.go,但方法签名按 TS 习惯用对象参数。
 */
export interface MemoryProvider {
  readonly type: MemoryProviderType;  // 'builtin' | 'mem0' | 'http'
  readonly id: string;                 // provider 实例 id

  // —— 检索 ——
  search(ctx: ProviderCallContext, req: SearchRequest): Promise<SearchResult[]>;
  // —— 写入 ——
  add(ctx: ProviderCallContext, mem: NewMemoryInput): Promise<MemoryRef>;
  update(ctx: ProviderCallContext, id: string, patch: MemoryPatch): Promise<void>;
  delete(ctx: ProviderCallContext, ids: string[]): Promise<void>;
  // —— 对话钩子(memoh 风格,可选实现,默认 no-op)——
  onBeforeChat?(ctx: ProviderCallContext, req: BeforeChatRequest): Promise<BeforeChatResult>;
  onAfterChat?(ctx: ProviderCallContext, req: AfterChatRequest): Promise<void>;
  // —— 用量 ——
  usage?(ctx: ProviderCallContext): Promise<UsageResponse>;
  // —— 健康 ——
  status?(ctx: ProviderCallContext): Promise<ProviderStatus>;
}

/**
 * 可选能力接口 —— 通过 capability flag 或类型守卫按需调用。
 * 关键:外部后端不实现就不具备该能力,不必写 throw unsupported。
 * 借鉴 memoh 的 SourceSyncProvider / MarkdownIngestProvider / SemanticCompactProvider。
 */
export interface CompactCapability {
  compact(ctx: ProviderCallContext, opts: CompactOptions): Promise<CompactResult>;
}
export interface IngestCapability {
  ingest(ctx: ProviderCallContext, source: IngestSource): Promise<IngestResult>;
}
export interface SourceSyncCapability {
  rebuild(ctx: ProviderCallContext): Promise<RebuildResult>;
}

// 类型守卫(替代 Go 的 type assertion):
export const hasCompact = (p: MemoryProvider): p is MemoryProvider & CompactCapability =>
  'compact' in p;
export const hasIngest  = (p: MemoryProvider): p is MemoryProvider & IngestCapability =>
  'ingest' in p;
export const hasSourceSync = (p: MemoryProvider): p is MemoryProvider & SourceSyncCapability =>
  'rebuild' in p;
```

**关键约束 —— `ProviderCallContext` 必须承载 taint gate 所需信息**:

```ts
export interface ProviderCallContext {
  userId: string;
  projectId: string | null;
  // 信任来源:决定写入时记什么 sourceKind。
  // 这个字段是 agentboster 独有,memoh 没有 —— 是保留 taint gate 的关键。
  // 决策:所有 provider 强制遵守(详见 §1.2.1)。
  sourceKind: SourceKind;  // 'user_asserted' | 'assistant_observed' | 'tool_observed' | ...
  // 调用方标识,用于审计 Dream 变更
  initiatedBy?: 'extract' | 'dream' | 'agent-tool' | 'recall-feedback';
}
```

#### 1.2.1 sourceKind 透传策略(决策:所有 provider 强制)

所有 `MemoryProvider` 实现写入(`add`/`update`/`compact`)时**必须**消费 `ctx.sourceKind`:

- **BuiltinProvider**:原样写入 `long_term_memories.sourceKind` 列,保留现有 taint gate 全部规则(tool_observed 不进 profile、Dream boost 跳过、extractor 只降级)。
- **Mem0Provider / HttpProvider**:
  - 若对端 API 原生支持信任来源字段(如 mem0 的 `metadata`),按 `ctx.sourceKind` 透传;
  - 若不支持,按**最保守**的 `tool_observed` 处理 —— 这意味着外部 provider 默认不信任,always-on profile 不会自动注入外部记忆,除非显式 `user_asserted`。
  - 写入前在 provider 层做一次 `assertSourceKindAdmitted(sourceKind, action)` 校验,拒绝越权写入(如 tool_observed 的记忆不能标 user_asserted)。

**为什么强制而非 capability 探测**:taint gate 是安全边界,不是可选优化。capability 探测会让"某个 provider 忘了声明支持 sourceKind"变成静默漏洞。强制 + 最保守兜底把"忘记"变成"显式拒绝",失败模式安全。

**实现成本**:外部 provider 只需多接一个 `ctx.sourceKind` 参数,映射到对端字段或走保守路径,不增加接口复杂度。

### 1.3 Registry(借鉴 memoh registry.go 的 per-team lazy 缓存)

```ts
// lib/memory/provider/registry.ts(新建)

/**
 * per-(userId, providerId) 缓存 provider 实例。
 * 借鉴 memoh:首次访问才从 DB 懒加载配置 + 工厂化,Update 后驱逐。
 * 与 memoh 的差异:memoh 是 per-team;agentboster 单用户多项目,用 userId 粒度足够。
 */
export class MemoryProviderRegistry {
  private cache = new Map<string, MemoryProvider>();  // key: `${userId}:${providerId}`

  async get(ctx: ProviderCallContext, providerId: string): Promise<MemoryProvider> {
    const key = `${ctx.userId}:${providerId}`;
    let p = this.cache.get(key);
    if (!p) {
      const config = await loadProviderConfig(providerId);   // 从 DB
      p = await instantiateProvider(providerId, config);      // 工厂
      this.cache.set(key, p);
    }
    return p;
  }

  evict(userId: string, providerId?: string): void { /* ... */ }
}
```

**默认 provider**:借鉴 memoh 的 `DefaultBuiltinProviderID = "__builtin__"`,无显式配置时回退到 BuiltinProvider。

### 1.4 Context Packer(独立横切层,统一五源打包)

```
现状(context/index.ts 230-282 手动拼):
  recall results  ─┐
  trigger results ├─→ formatXxxForContext() → 拼成 message blocks
  profile         │   (无统一预算/重排,knowledge 完全不进来)
  session summary │
                   ┘

目标(借鉴 memoh context_packer.go 四阶段):
  recall + trigger + profile + session + knowledge(provider.search)
    │
    ▼
  ContextPacker.pack({ budget: 1800 chars, target: 6 })
    │
    ├─ Stage 1: 贪婪装入(按 score*importance 排序)
    ├─ Stage 2: 超预算 → 压缩现有条目腾位
    ├─ Stage 3: 剩余预算再分配
    └─ Stage 4: anti-lost-in-the-middle 重排(最优项放首尾)
    │
    ▼
  单一 ranked context block(注入 system prompt)
```

**为什么独立成层**:把"从哪来"和"怎么拼进 prompt"解耦。新加来源(如未来 RAG-from-confluence)只需实现 provider.search,packer 自动纳入预算。

### 1.5 缓存版本号(借鉴 memoh 的 MemoryVersion,带防漏机制)

新增 `MemoryVersionCapability` 能力接口 + **集中式版本计数器**:

```ts
export interface MemoryVersionCapability {
  /** 读当前版本号(用于 cache key)。 */
  memoryVersion(ctx: ProviderCallContext): Promise<number>;
}
```

#### 关键设计:版本自增不能靠调用方记得调

你的反问点中了要害:"删旧代码"若靠"每个写路径记得自增 version",静默 stale 几乎不可避免。解法是把自增从**运行时约定**提升到**结构层强制**:

**方案:Write Gate(单一写入闸口)**

所有写操作(`add`/`update`/`delete`/`compact`/Dream apply)不直接走 provider,而是走一个集中的 `commitMemoryWrite()` 函数。它保证三件事原子发生:

```ts
// lib/memory/provider/write-gate.ts
async function commitMemoryWrite(
  ctx: ProviderCallContext,
  provider: MemoryProvider,
  op: () => Promise<void>,
): Promise<void> {
  await op();                         // 1. 执行实际写
  bumpMemoryVersion(ctx.userId);      // 2. 同进程版本自增(内存变量)
  await persistVersionBump(ctx);      // 3. 落库(DB 的 memory_version_log 表)
  notifyPeerProcesses(ctx.userId);    // 4. 跨进程广播(多副本部署)
}
```

**防漏靠结构,不靠纪律**:
1. **provider 接口不暴露裸 `add/update/delete`**:写入方法只在内部接口(`MemoryProviderInternal`)上,外部调用方拿到的是 `CommittedMemoryProvider`,它的写方法自动包 `commitMemoryWrite`。调用方**无法**绕过。
2. **Bumppoint 单一**:整个 codebase 只有 `commitMemoryWrite` 一处调用 `bumpMemoryVersion`,lint 规则 / 代码 review 拒绝新增第二个调用点。
3. **落库副本 + 心跳校验**:version 不光在内存,还写 `memory_version_log`(单调递增)。进程启动时读最大值;跨进程靠 Postgres `NOTIFY`/Upstash pub-sub 同步。即使某个副本错过广播,下次校验也会发现版本滞后并刷新。
4. **可观测黄金信号**:context packer 缓存命中时记录 `version` 和 `ageMs`;若 ageMs > 阈值但未刷新,告警"可能 stale"。

**回退保险(Phase 3 双轨过渡期的价值)**:过渡期保留 `cache-invalidation.ts` 作为双保险,version 漏增时手动失效仍能兑底。观察期(建议 2 周)确认无 stale 报告后,才删手动代码。这是为什么选"方案 2 双轨过渡期"而非激进删除。

---

## 2. 分步迁移路径

> 原则:每步可独立合并、可回滚;每步后 `yarn check:lint` + `yarn build` + 相关 `.test.ts` 必须绿。

### Phase 0 · 准备(无行为变更,纯脚手架)

**产出**:`lib/memory/provider/` 新目录
- `types.ts` —— 上述接口定义
- `registry.ts` —— 空壳 Registry(只 builtin 一个 provider)
- `context-packer.ts` —— 空壳 packer(暂时直接返回输入,不改排序)

**保护**:不动任何现有文件,只是新增。现有 `recall.ts`/`triggers.ts`/`profile.ts` 继续按原路径工作。

**验证**:新增单元测试覆盖接口签名 + registry get/evict + packer 无操作路径。

---

### Phase 1 · BuiltinProvider 适配器(包旧实现,不改逻辑)

**产出**:`lib/memory/provider/builtin.ts`
- 把现有 `lib/memory/long-term.ts` / `recall.ts` / `triggers.ts` / `extract.ts` / `profile.ts` 包成 `BuiltinProvider implements MemoryProvider, CompactCapability, SourceSyncCapability, IngestCapability, MemoryVersionCapability`
- 内部仍调用现有函数,**不改任何业务逻辑**
- taint gate 逻辑下沉到 `ProviderCallContext.sourceKind` → 现有 `sourceKind` 列的映射(纯透传)

**关键**:`extract.ts` 的 `sourceKind` 信任降级规则原样保留;`profile.ts` 的 tool_observed 排除规则原样保留。这一步只做"接口适配",不做"逻辑改动"。

**验证**:
- 新增 `builtin-provider.test.ts`,断言它转发到底层函数的参数/返回值一致
- 现有所有 `.test.ts` 不动,必须全绿(证明行为未变)

---

### Phase 2 · Context Builder 切到 Packer(行为等价切换)

**产出**:改 `lib/workflow/agent/context/index.ts`
- 用 `ContextPacker.pack(...)` 替换 230-282 行的手动拼接
- **暂时**让 packer 的 stage 1-4 行为与现有 `formatRecalledMemoriesForContext` + `formatTriggeredMemoriesForContext` 完全等价(即 packer 第一版只做"统一入口",不做预算重排)
- knowledge 仍不进自动注入(避免 scope 蔓延)

**验证**:
- context builder 的输入输出 snapshot 测试(若没有就补一个)必须等价
- `yarn build` 必须绿(workflow bundle 不能破)

**风险点**:context/index.ts 在 workflow 树里,packer 不得引入 `node:*` 顶层 import(见 AGENTS.md 红线)。packer 内部若需 hash 用 `await import('node:crypto')`。

---

### Phase 3 · 引入 MemoryVersion + Write Gate + 双轨过渡期

**决策:采用双轨过渡期(方案 2),不激进删除手动失效代码。**

**产出**:
- 新增 `lib/memory/provider/write-gate.ts` —— 集中写入闸口(见 §1.5)
- BuiltinProvider 的写方法改为只暴露 `CommittedMemoryProvider`(自动包 write gate),裸写接口下沉为 internal
- 新增 `memory_version_log` 表(单调递增)+ 进程级 version 缓存 + 跨进程 Postgres `NOTIFY`
- ContextPacker 的 cache key 加 `memoryVersion`
- **保留** `cache-invalidation.ts` 的 recallCache/triggerCache 手动失效,作为双保险
- 加可观测:packer cache 命中时记录 `{ version, ageMs, source: 'version'|'manual'|'fallback' }`

**防漏自增的验证(结构性,非约定性)**:
- 静态检查:grep 确认 `bumpMemoryVersion` 全 codebase 只在 `write-gate.ts` 出现一次
- 集成测试:对每个写入口(Dream apply / extract ADD·UPDATE·DELETE / agent-tool add·update·delete)起一个用例,写后断言 version 严格递增
- 故障注入测试:模拟 write gate 异常中断,断言 version 未增时手动失效仍能兑底(证明双轨安全)
- 生产观测期:Phase 3 合并后观察 2 周,确认无 stale 告警,才进入 Phase 3.5

**Phase 3.5(观察期后才做)**:删除 `cache-invalidation.ts` 的手动串联代码,正式单轨。

**风险点**:
- write gate 必须是写路径的唯一入口,否则旁路写不会自增 version。Phase 3 的 grep 检查 + code review 针对
- 跨进程 `NOTIFY` 在 Neon serverless driver 上不可用(neon-http 无持久连接)—— Vercel 部署改用 Upstash pub-sub 或轮询 `memory_version_log.max(id)`(TTL 窗口内)
- Dream apply 是批量写,write gate 要支持事务性 multi-op(一次 op 内多个变更共享一个 version bump,避免拍雪崩)

---

### Phase 4 · Packer 真正生效(开启四阶段打包)

**产出**:ContextPacker 启用 stage 2-4(压缩让位 + 再分配 + anti-lost-in-the-middle 重排)
- 从"等价模式"切到"优化模式"
- 加可观测:packer 输出附 `packerStats: { stage, budgetUsed, itemsDropped }` 便于调试

**验证**:
- 对比测试:同一批 recall+trigger 输入,新 packer 产出的 context 在 token 预算内信息密度 ≥ 旧实现
- 人工 review 几轮真实对话的 context block,确认重排没破坏时序语义

**回滚**:feature flag `MEMORY_PACKER_OPTIMIZE=true/false`,出问题秒切回等价模式。

---

### Phase 5(可选)· 外部 Provider CRUD 补全 + 接入 packer

**产出**:
- `lib/knowledge/providers/mem0.ts` / `http.ts` 从只 `search` 扩到 `add/delete/update`(若对端 API 支持)
- ContextPacker 增加 `includeProviders: MemoryProvider[]` 参数,把远程 provider 的 search 结果纳入预算
- 给 `KnowledgeProvider` 接口迁移到 `MemoryProvider`(向后兼容别名)

**这一步可延后**:只有当确实需要"把记忆写回 mem0"或"让 knowledge 自动注入"时才做。当前的 read-only knowledge 作为独立 RAG 库也是合理设计。

---

## 3. 风险与回滚

| 风险 | 缓解 |
|------|------|
| workflow bundle 被 provider 抽象层的新依赖撑破 | provider/packer 文件遵守 AGENTS.md:无 `node:*` 顶层 import,第三方包(如未来 mem0 SDK)加 `serverExternalPackages` |
| taint gate 在适配中漏传 `sourceKind` | Phase 1 的 `builtin-provider.test.ts` 必须覆盖每个写入方法的 sourceKind 透传;Dream/extract/profile 三处的 tool_observed 排除用例不能删 |
| Dream 变异预算被新 compact 接口绕过 | `CompactCapability` 的实现必须复用 `phase3-sanitize.ts` 的 maxRetiredFraction,不另写压缩逻辑 |
| 多写路径漏自增 version → 缓存 stale | **结构性防护(非纪律)**:Write Gate 是唯一写入闸口(§1.5),裸写接口不暴露;grep 断言 `bumpMemoryVersion` 只在 write-gate.ts;双轨过渡期手动失效兼底;故障注入测试验证兼底。**Phase 1 现状(2026-08-07)**:债务守卫 `legacy-write-debt.test.ts` 钉住基线 4 个 legacy 直调文件(extract.ts / dream/apply.ts / long-term.ts 内部 / cache-invalidation.ts),这些路径暂不经 provider,**Phase 3 必须先迁移它们再删 cache-invalidation.ts**。 |
| 重排破坏时序语义(用户觉得"记忆乱序了") | Phase 4 有 feature flag;先在 dev 环境跑一周观察 packerStats 再全量 |
| Neon serverless 无 `NOTIFY` → 跨副本 version 不同步 | Vercel 部署用 Upstash pub-sub 或 TTL 内轮询 `memory_version_log.max(id)`;自托管用 pg `NOTIFY` |

**整体回滚**:每个 Phase 独立 commit,任意一步出问题 `git revert` 该 commit 即可。

- Phase 3 双轨期:revert 后手动失效代码仍在(未删),零风险
- Phase 3.5(删手动代码):需观察期确认无 stale 后才执行;revert 需手动恢复 `cache-invalidation.ts`(从 git 历史)

---

## 4. 不做的事(明确边界)

- **不改 Dream 的三阶段流水线** —— 它是 agentboster 强项,memoh 的 compact 只是借鉴其"接口位"而非"替换实现"
- **不改 trigger phrase / recall-intent 的正则逻辑** —— 零成本分流保留
- **不合并 `long_term_memory_chunks` 与 `knowledge_chunks` 两张表** —— 物理合并风险高、收益不明确;接口统一已足够解耦
- **不引入 per-team 多租户** —— memoh 的 team 概念 agentboster 用不上,registry 用 userId 粒度

---

## 5. 工作量估计

| Phase | 文件改动 | 复杂度 | 可合并性 |
|-------|---------|--------|---------|
| 0 脚手架 | 新增 3 文件 | 低 | 独立 PR |
| 1 BuiltinProvider | 新增 1 + 不动旧 | 中 | 独立 PR |
| 2 Context 切 packer(等价) | 改 1(context/index.ts) | 中 | 独立 PR |
| 3 MemoryVersion + Write Gate(双轨) | 新增 write-gate.ts + memory_version_log 表 + packer cache key | 高 | 独立 PR,需仔细;双轨期零删除 |
| 3.5 删手动失效代码 | 删 cache-invalidation.ts 串联 | 低 | 观察期后才做 |
| 4 Packer 优化模式 | 改 packer | 中 | 独立 PR + feature flag |
| 5 外部 provider CRUD(可选) | 改 2 + 迁移 | 中 | 可延后 |

Phase 0-2 是"引入抽象、行为不变",低风险;Phase 3 是关键转折点(开始删旧代码);Phase 4 才真正产生用户可见收益;Phase 5 看需求。
