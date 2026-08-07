/**
 * MemoryProvider —— 统一记忆接口的核心类型定义。
 *
 * 设计来源:借鉴 memoh (`internal/memory/adapters/provider.go` + `types.go`)
 * 的"窄主接口 + opt-in 能力接口"模式,但按 TS 习惯用对象参数 + 类型守卫。
 *
 * 关键约束(见 docs/memory-provider-unification-plan.md §1.2):
 *  - 所有 provider 实现同一个 `MemoryProvider` 主接口(检索 + 写入)
 *  - `Compact/Ingest/SourceSync/MemoryVersion` 是可选能力接口,按需实现
 *  - `ProviderCallContext.sourceKind` 是 agentboster 独有字段,承载 taint gate
 *    (memoh 没有这个 —— 它是保留信任分级的关键,所有 provider 强制遵守)
 *
 * Phase 0 状态:纯类型,无运行时实现。Phase 1 才把现有 lib/memory 包成
 * BuiltinProvider。本文件不 import 任何现有 memory 模块,避免循环依赖。
 */

import type { LongTermMemorySourceKind } from '@/lib/core/db/memory/long-term';

// ─── Provider 类型与标识 ────────────────────────────────────────────

/** 所有受支持的 provider 类型。新增后端时在此追加。 */
export type MemoryProviderType = 'builtin' | 'mem0' | 'http';

/** provider 实例 id。`__builtin__` 是无显式配置时的虚拟兜底 id(借鉴 memoh)。 */
export const DEFAULT_PROVIDER_ID = '__builtin__' as const;

/** provider 配置(DB 行 `memory_providers` 的 config 字段,工厂解析)。 */
export type ProviderConfig = Record<string, unknown>;

// ─── 调用上下文(taint gate 载体)──────────────────────────────────

/**
 * 读路径调用上下文(检索/健康/用量)。
 *
 * 不带 sourceKind —— 读路径读的是已存行,其 sourceKind 来自 DB 而非调用方。
 * 强行要求读路径填 sourceKind 会通调用方填假值,污染审计语义(reviewer #3)。
 */
export interface ProviderReadContext {
  userId: string;
  projectId: string | null;
}

/**
 * 写路径调用上下文(增删改/compact/ingest)。
 *
 * `sourceKind` 是 taint gate 的关键:写入时决定记什么信任来源。
 *  - BuiltinProvider 原样写入 `long_term_memories.source_kind` 列
 *  - 外部 provider 不支持原生区分时按最保守 `tool_observed` 处理
 *  - `initiatedBy` 用于审计 Dream / extract 变更链路
 *
 * 见 docs/memory-provider-unification-plan.md §1.2.1。
 */
export interface ProviderWriteContext extends ProviderReadContext {
  sourceKind: LongTermMemorySourceKind;
  initiatedBy?: 'extract' | 'dream' | 'agent-tool' | 'recall-feedback';
}

/**
 * 兼容别名:调集所有上下文字段(读路径的 sourceKind 可选)。
 * 保留是为了让未拆分读写的外部调用方仍可用;新代码应优先用
 * ProviderReadContext(读)/ ProviderWriteContext(写)。
 */
export type ProviderCallContext = ProviderReadContext | ProviderWriteContext;

// ─── 主接口:检索 + 写入 ────────────────────────────────────────────

/** `search` 请求。 */
export interface SearchRequest {
  query: string;
  topK?: number;
  minConfidence?: number;
  /**
   * 是否调用远程 provider(mem0/http)。默认 true。
   * 只控“要不要发起远程请求”,不影响本地 rerank。
   */
  enableRemote?: boolean;
  /**
   * 是否对结果走 cross-reranker 重排。默认 true。
   * 仅控 rerank 行为;远程开关由 enableRemote 负责。
   */
  enableRerank?: boolean;
}

/** `search` 返回的单条结果。字段对齐现有 `RecalledMemory` 形状。 */
export interface SearchResult {
  memoryId?: string;
  key: string;
  content: string;
  score: number;
  importance?: number;
  sourceKind?: LongTermMemorySourceKind;
  projectId?: string | null;
  /** 命中模式,可观测用(借鉴 memoh `RetrievalMode/FallbackReason`)。 */
  retrievalMode?: string;
  fallbackReason?: string;
}

/** 记忆类型(对齐现有 long-term.ts)。 */
export type MemoryType = 'fact' | 'preference' | 'decision' | 'conversation';

/** Dream 生命周工状态(对齐现有 schema)。 */
export type DreamStatus =
  | 'active'
  | 'tentative'
  | 'superseded'
  | 'contradicted';

/** 新增记忆输入。字段对齐现有 upsertLongTermMemory(long-term.ts:186),避免包 BuiltinProvider 时丢字段(reviewer #1)。 */
export interface NewMemoryInput {
  key: string;
  content: string;
  memoryType?: MemoryType;
  importance?: number;
  projectId?: string | null;
  /** 不提供时取 `ctx.sourceKind`。 */
  sourceKindOverride?: LongTermMemorySourceKind;
  /** 作者挂载的触发短语(triggers.ts 预过滤用)。 */
  triggerPhrases?: string[];
  /** Dream 提案状态;默认 'active'。Dream 写 'tentative'。 */
  dreamStatus?: DreamStatus;
  /** Dream 元数据(provenance / lineage / ratify 信息)。 */
  dreamMeta?: Record<string, unknown>;
}

/**
 * 更新补丁。
 *
 * reviewer A2:仅保留 Phase 1 真正持久化的字段(content)。此前声明的
 * importance/sourceKind/memoryType/triggerPhrases/dreamStatus 被旧实现
 * 静默吞掉(返回 resolve 但不落库),调用方误以为更新成功 —— 等价于
 * “伪装成功”。这些字段在 updateLongTermMemory 真正支持之前从主契约移出。
 */
export interface MemoryPatch {
  content?: string;
}

/** 写入返回的引用。 */
export interface MemoryRef {
  id: string;
  key: string;
}

/**
 * 统一记忆接口 —— 所有后端实现。
 *
 * 写入方法(add/update/delete)在本接口上为"裸"签名;实际对外暴露的是
 * `CommittedMemoryProvider`(见 write-gate.ts),它会自动包版本自增。
 * 调用方拿到的 provider 已封箱,无法绕过 write gate。
 */
export interface MemoryProvider {
  readonly type: MemoryProviderType;
  readonly id: string;

  // —— 检索(读路径,用 ReadContext)——
  search(ctx: ProviderReadContext, req: SearchRequest): Promise<SearchResult[]>;

  // —— 写入(裸;实际通过 CommittedMemoryProvider 包封)——
  add(ctx: ProviderWriteContext, mem: NewMemoryInput): Promise<MemoryRef>;
  update(
    ctx: ProviderWriteContext,
    id: string,
    patch: MemoryPatch,
  ): Promise<void>;
  delete(ctx: ProviderWriteContext, ids: string[]): Promise<void>;

  // —— 对话钩子(memoh 风格,可选,默认 no-op)——
  onBeforeChat?(
    ctx: ProviderReadContext,
    req: BeforeChatRequest,
  ): Promise<BeforeChatResult>;
  onAfterChat?(ctx: ProviderWriteContext, req: AfterChatRequest): Promise<void>;

  // —— 健康(可选,读路径)——
  status?(ctx: ProviderReadContext): Promise<ProviderStatus>;

  // —— 用量(可选,读路径)——
  usage?(ctx: ProviderReadContext): Promise<UsageResponse>;
}

// ─── 对话钩子类型 ────────────────────────────────────────────────────

export interface BeforeChatRequest {
  query: string;
  topK?: number;
}

export interface BeforeChatResult {
  /** 已格式化的注入文本(空串表示无内容)。 */
  injectedText: string;
  /** 命中的记忆条数,用于可观测。 */
  hitCount: number;
  retrievalMode?: string;
}

export interface AfterChatRequest {
  /** 本轮对话的原始消息序列。 */
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
}

// ─── 健康 / 用量 ────────────────────────────────────────────────────

export interface ProviderStatus {
  mode: 'active' | 'disabled' | 'degraded';
  detail?: string;
}

export interface UsageResponse {
  count: number;
  /** 字符或 token 上限,provider 自定语义。 */
  budget?: number;
}

// ─── 可选能力接口(opt-in capabilities)──────────────────────────────

/**
 * 语义压缩能力。
 * 借鉴 memoh `SemanticCompactProvider`;agentboster 的实现必须复用
 * `dream/phase3-sanitize.ts` 的 maxRetiredFraction 变异预算,不另写压缩逻辑。
 */
export interface CompactCapability {
  compact(
    ctx: ProviderWriteContext,
    opts: CompactOptions,
  ): Promise<CompactResult>;
}

export interface CompactOptions {
  /** 目标保留比例(0-1),如 0.5 表示压到一半。 */
  ratio?: number;
  /** 衰减天数,早于此的记忆优先压缩。 */
  decayDays?: number;
}

export interface CompactResult {
  before: number;
  after: number;
  /** 被合并/删除的 id 清单,供审计。 */
  retiredIds: string[];
}

/** Markdown 摄入能力(借鉴 memoh `MarkdownIngestProvider`)。 */
export interface IngestCapability {
  ingest(
    ctx: ProviderWriteContext,
    source: IngestSource,
  ): Promise<IngestResult>;
}

export interface IngestSource {
  /** Markdown 文件内容数组。 */
  files: Array<{ path: string; content: string }>;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
}

/** 从权威源重建派生存储(借鉴 memoh `SourceSyncProvider`)。 */
export interface SourceSyncCapability {
  rebuild(ctx: ProviderWriteContext): Promise<RebuildResult>;
}

export interface RebuildResult {
  ok: boolean;
  detail?: string;
}

/**
 * 内存版本号能力(借鉴 memoh `MemoryVersionProvider`)。
 * 读当前版本号;自增由 write-gate 统一负责,provider 不直接 bump。
 * 见 docs/memory-provider-unification-plan.md §1.5。
 */
export interface MemoryVersionCapability {
  memoryVersion(ctx: ProviderReadContext): Promise<number>;
}

// ─── 类型守卫(替代 Go type assertion)──────────────────────────────

export const hasCompact = (
  p: MemoryProvider,
): p is MemoryProvider & CompactCapability =>
  typeof (p as unknown as CompactCapability).compact === 'function';

export const hasIngest = (
  p: MemoryProvider,
): p is MemoryProvider & IngestCapability =>
  typeof (p as unknown as IngestCapability).ingest === 'function';

export const hasSourceSync = (
  p: MemoryProvider,
): p is MemoryProvider & SourceSyncCapability =>
  typeof (p as unknown as SourceSyncCapability).rebuild === 'function';

export const hasMemoryVersion = (
  p: MemoryProvider,
): p is MemoryProvider & MemoryVersionCapability =>
  typeof (p as unknown as MemoryVersionCapability).memoryVersion === 'function';

// ─── 工厂类型 ────────────────────────────────────────────────────────

/** 工厂签名:从 config 构造 provider 实例。借鉴 memoh `Factory`。 */
export type MemoryProviderFactory = (
  id: string,
  config: ProviderConfig,
) => Promise<MemoryProvider> | MemoryProvider;
