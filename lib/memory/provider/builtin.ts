/**
 * BuiltinProvider —— 把现有 lib/memory 包成 MemoryProvider。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 1。
 *
 * 关键原则:**包旧不改逻辑**。所有方法桥接到现有函数,行为等价。
 *  - 现有函数自带的 invalidateRecallCache/invalidateTriggerCache/invalidateProfileCache
 *    保留不动(Phase 3 才用 MemoryVersion 替换它们)
 *  - taint gate 的 sourceKind 透传:ctx.sourceKind → 现有函数的 sourceKind 参数
 *  - recall 读路径不需要 sourceKind,但 ProviderCallContext 必填 —— 这是 §1.2.1
 *    决策的代价,读路径调用方填 ctx 时用 'assistant_observed'(中性默认)
 *
 * 能力接口实现:
 *  - MemoryVersionCapability:✅ 接 write-gate 计数器
 *  - CompactCapability:⏳ Phase 后续接 Dream(先 throw,避免误用)
 *  - IngestCapability / SourceSyncCapability:⏳ Phase 后续
 */

import {
  deleteLongTermMemory,
  getLongTermMemory,
  recallRelevantMemories,
  upsertLongTermMemory,
  updateLongTermMemory,
  type RecalledMemory,
} from '@/lib/memory';
import { getConfig } from '@/lib/core/kv/config';
import type { AppConfig } from '@/types/config';

import type {
  MemoryPatch,
  MemoryRef,
  MemoryVersionCapability,
  NewMemoryInput,
  ProviderReadContext,
  ProviderWriteContext,
  SearchRequest,
  SearchResult,
} from './types';
import { type MemoryProvider, hasMemoryVersion } from './types';
import { readMemoryVersion } from './write-gate';

const DEFAULT_SEARCH_TOP_K = 5;
const DEFAULT_SEARCH_MIN_CONFIDENCE = 0.02;

export interface BuiltinProviderDeps {
  /** 可选 config 注入(测试用);默认运行时各函数自取。 */
  config?: AppConfig;
}

/**
 * 创建 BuiltinProvider 实例(模块内部使用)。
 *
 * reviewer A6:本函数不导出,调用方拿不到裸实例,无法绕过 write gate。
 * 公开访问统一经 `createCommittedBuiltinProvider()`(builtin-factory.ts),
 * 后者总是包 `wrapWithWriteGate()` 并返回 `CommittedMemoryProvider`。
 */
function createBuiltinProvider(
  id: string,
  deps: BuiltinProviderDeps = {},
): BuiltinProvider {
  return new BuiltinProviderImpl(id, deps);
}

/** 模块内部导出(仅 builtin-factory.ts 使用)。 */
export function _createBuiltinProviderInternal(
  id: string,
  deps: BuiltinProviderDeps = {},
): BuiltinProvider {
  return createBuiltinProvider(id, deps);
}

/** BuiltinProvider 的静态类型:主接口 + 已实现的能力接口。 */
export type BuiltinProvider = MemoryProvider &
  MemoryVersionCapability & {
    // Compact/Ingest/SourceSync 在 Phase 1 尚未实现,先不在类型上声明
    // (类型守卫 hasCompact 等会返回 false,符合"未实现即不具备")
  };

class BuiltinProviderImpl implements MemoryProvider, MemoryVersionCapability {
  readonly type = 'builtin' as const;

  constructor(
    readonly id: string,
    private deps: BuiltinProviderDeps = {},
  ) {}

  // ─── 检索 ────────────────────────────────────────────────────────

  async search(
    ctx: ProviderReadContext,
    req: SearchRequest,
  ): Promise<SearchResult[]> {
    // 读路径不需要 sourceKind(见 types.ts ProviderReadContext)
    const recalled = await recallRelevantMemories({
      userId: ctx.userId,
      query: req.query,
      topK: req.topK ?? DEFAULT_SEARCH_TOP_K,
      minConfidence: req.minConfidence ?? DEFAULT_SEARCH_MIN_CONFIDENCE,
      config: this.deps.config,
    });
    return recalled.map(recalledToSearchResult);
  }

  // ─── 写入 ────────────────────────────────────────────────────────

  async add(
    ctx: ProviderWriteContext,
    mem: NewMemoryInput,
  ): Promise<MemoryRef> {
    const sourceKind = mem.sourceKindOverride ?? ctx.sourceKind;
    const row = await upsertLongTermMemory({
      userId: ctx.userId,
      key: mem.key,
      content: mem.content,
      memoryType: mem.memoryType,
      importance: mem.importance,
      projectId: mem.projectId ?? ctx.projectId,
      sourceKind,
      triggerPhrases: mem.triggerPhrases,
      dreamStatus: mem.dreamStatus,
      dreamMeta: mem.dreamMeta,
      config: this.deps.config,
    });
    return { id: row.memory.id, key: mem.key };
  }

  async update(
    ctx: ProviderWriteContext,
    id: string,
    patch: MemoryPatch,
  ): Promise<void> {
    // reviewer A2:MemoryPatch 主契约仅含 content(当前唯一被持久化的字段)。
    // 其它字段(importance/sourceKind/memoryType/triggerPhrases/dreamStatus)
    // 在 updateLongTermMemory 真正支持前不再出现在契约中,避免静默吞掉。
    if (patch.content === undefined) {
      // 没有内容要更新,无操作(不报错,保持幂等)
      return;
    }
    // ⚠️ 安全限制(reviewer #5):现版 updateLongTermMemory 不接 userId,
    // 底层 updateLongTermMemoryRow 在 userId 省略时不带 owner 过滤 ——
    // 可能跨用户修改。为与 delete 的 per-user 隔离姿态一致,这里显式
    // 校验 id 的 owner 与 ctx.userId 一致后才调 update。
    const existing = await getLongTermMemory(id);
    if (!existing) {
      return; // 行不存在,幂等 no-op
    }
    if (existing.userId !== ctx.userId) {
      // 跨用户写拒绝(与 delete 行为一致:删不掉也不报错)
      return;
    }
    await updateLongTermMemory({
      id,
      content: patch.content,
      config: this.deps.config,
    });
  }

  async delete(ctx: ProviderWriteContext, ids: string[]): Promise<void> {
    for (const id of ids) {
      await deleteLongTermMemory(id, { userId: ctx.userId });
    }
  }

  // ─── 对话钩子(Phase 1 不实现,默认 undefined)──────────────────
  // onBeforeChat / onAfterChat 由上层 context builder 直接调 recall + extract,
  // Phase 1 不把它们搬进 provider(避免改变现有调用链)。

  // ─── 健康(reviewer A5:检测 embedding_model 缺失)────────

  async status(_ctx: ProviderReadContext) {
    // reviewer A5:必须与 recall 策略解析使用同一运行时配置源。
    // 注入 config 优先(测试可控),否则运行时 getConfig() 兜底 ——
    // 与 recallRelevantMemories 内部的 getEffectiveConfig 一致。
    const cfg = this.deps.config ?? (await getConfig().catch(() => null));
    const hasEmbedding = Boolean(cfg?.models?.embedding_model);
    return {
      mode: hasEmbedding ? ('active' as const) : ('degraded' as const),
      detail: hasEmbedding
        ? 'builtin pg + pgvector + edges'
        : 'builtin keyword-only (no embedding_model configured)',
    };
  }

  // ─── MemoryVersionCapability ─────────────────────────────────────

  async memoryVersion(ctx: ProviderReadContext): Promise<number> {
    return await readMemoryVersion(ctx.userId);
  }
}

// ─── RecalledMemory → SearchResult 映射 ─────────────────────────────

function recalledToSearchResult(m: RecalledMemory): SearchResult {
  return {
    // reviewer #6:memoryId 缺失用 undefined(类型可选),不填空串 ——
    // 空串是合法"有值",packer 未来跨源去重会误判为同一。
    ...(m.memoryId ? { memoryId: m.memoryId } : {}),
    key: '', // RecalledMemory 没有 key 字段(recall 不返回 key)
    content: m.content,
    score: m.score,
    ...(m.sourceKind ? { sourceKind: m.sourceKind } : {}),
    // retrievalMode / fallbackReason 在 Phase 后续从 recall 内部透出
    // (现有 recallRelevantMemories 不返回 mode,但内部有 strategy 信号)
  };
}

// ─── 类型断言:BuiltinProvider 实现了 MemoryVersionCapability ──────
// 编译期保证 createBuiltinProvider 的返回值满足 MemoryVersionCapability。
const _typeCheck: MemoryVersionCapability = null as unknown as BuiltinProvider;
void _typeCheck;
void hasMemoryVersion; // 保留 import 供外部类型守卫使用
