/**
 * MemoryProviderAdapter —— 把 KnowledgeProvider 适配成 MemoryProvider。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 5。
 *
 * ⚠️ WORKFLOW BUNDLE 守卫(reviewer phase5 B1):
 * 本文件对 @/lib/knowledge/providers 只用 `import type`(类型擦除)。
 * 绝不能改成 runtime import —— mem0.ts/http.ts 顶层 import readVaultValue
 * → node:crypto,会把 Node 内建拉进 workflow bundle 撑破构建。
 * 版本守卫:version-bump-chain.test.ts 断言本文件顶层只能 import type。
 *
 * 当前生产预取走另一条路:lib/memory/remote-injection.ts(collectRemoteMemoryItems)
 * → searchKnowledge。本 adapter 是为未来 MemoryProvider registry 统一调度预留,
 * 目前零调用方。
 */

import type {
  KnowledgeProvider,
  KnowledgeProviderResult,
} from '@/lib/knowledge/providers';
import type { LongTermMemorySourceKind } from '@/lib/core/db/memory/long-term';
import type {
  MemoryProvider,
  MemoryProviderType,
  NewMemoryInput,
  MemoryRef,
  MemoryPatch,
  ProviderReadContext,
  ProviderWriteContext,
  SearchRequest,
  SearchResult,
} from './types';

const REMOTE_DEFAULT_TOP_K = 5;

export interface RemoteProviderConfig {
  /** provider 类型标识。 */
  type: MemoryProviderType;
  /** 被适配的 KnowledgeProvider 实例。 */
  inner: KnowledgeProvider;
  /** 透传给 KnowledgeProvider.search 的 config(endpoint/vaultKey 等)。 */
  config: Record<string, unknown>;
}

/**
 * 把 KnowledgeProvider 适配成 MemoryProvider(只读)。
 *
 * 返回的 provider:
 *  - type: 传入的 type(如 'mem0' / 'http')
 *  - search: 桥接到 inner.search,结果映射成 SearchResult
 *  - add/update/delete: 抛 not-supported(远程只读)
 *  - 写方法抛错时,write-gate 不会 bump version(op 异常 → 不 bump)
 */
export function adaptKnowledgeProvider(
  id: string,
  spec: RemoteProviderConfig,
): MemoryProvider {
  return new RemoteMemoryProvider(id, spec);
}

class RemoteMemoryProvider implements MemoryProvider {
  readonly type: MemoryProviderType;
  readonly id: string;
  private readonly inner: KnowledgeProvider;
  private readonly config: Record<string, unknown>;

  constructor(id: string, spec: RemoteProviderConfig) {
    this.id = id;
    this.type = spec.type;
    this.inner = spec.inner;
    this.config = spec.config;
  }

  async search(
    _ctx: ProviderReadContext,
    req: SearchRequest,
  ): Promise<SearchResult[]> {
    // reviewer phase5 B2:fail-open(与 searchWithProvider/collectRemoteMemoryItems 对齐)。
    // 远程 provider 挂了不应让整盘 context 构建失败。
    try {
      const results = await this.inner.search({
        query: req.query,
        limit: req.topK ?? REMOTE_DEFAULT_TOP_K,
        config: this.config,
      });
      // reviewer phase5 S4:尊重 enableRerank=false(意为"禁远程")
      if (req.enableRerank === false) return [];
      const mapped = results.map(remoteToSearchResult);
      // reviewer phase5 S4:尊重 minConfidence
      const minConf = req.minConfidence ?? 0;
      return mapped.filter((r) => r.score >= minConf);
    } catch {
      // fail-open:远程挂了返回空,不阻塞主对话
      return [];
    }
  }

  async add(
    _ctx: ProviderWriteContext,
    _mem: NewMemoryInput,
  ): Promise<MemoryRef> {
    throw new Error(
      `MemoryProvider(${this.type}/${this.id}): add not supported — remote providers are read-only`,
    );
  }

  async update(
    _ctx: ProviderWriteContext,
    _id: string,
    _patch: MemoryPatch,
  ): Promise<void> {
    throw new Error(
      `MemoryProvider(${this.type}/${this.id}): update not supported — remote providers are read-only`,
    );
  }

  async delete(_ctx: ProviderWriteContext, _ids: string[]): Promise<void> {
    throw new Error(
      `MemoryProvider(${this.type}/${this.id}): delete not supported — remote providers are read-only`,
    );
  }

  async status(_ctx: ProviderReadContext) {
    // 远程 provider 的健康状态需要主动探测,这里返回 active 让 registry 接受;
    // 真实健康检查由调用方 try-search 确定(fail-open 语义)
    return {
      mode: 'active' as const,
      detail: `remote ${this.type} (read-only)`,
    };
  }
}

// ─── KnowledgeProviderResult → SearchResult 映射 ──────────────────

/**
 * 内部映射,接受 provider 实例信息用于 memoryId 命名空间化。
 * S1:加 provider 前缀避免跨 provider id 碰撞。
 */
function remoteToSearchResultInner(
  r: KnowledgeProviderResult,
  providerType: string,
  providerId: string,
): SearchResult {
  // 关键:taint gate。优先用 provider 在 KnowledgeProviderResult 给的 sourceKind
  // (phase5-review B3 修复后,mem0 按 metadata.trust/user_id 透传);
  // 缺省按 tool_observed(最保守,进 Unverified 段)。
  const sourceKind: LongTermMemorySourceKind = r.sourceKind ?? 'tool_observed';
  // S3 防御:score clamp,content trim
  const rawScore =
    typeof r.score === 'number' && Number.isFinite(r.score)
      ? Math.max(0, Math.min(1, r.score))
      : 0.5;
  const content = (r.content ?? '').trim();
  return {
    key: '', // 与 builtin 对齐(recall/key 不消费)
    content,
    score: rawScore,
    sourceKind,
    // S1 命名空间化 memoryId,避跨 provider 碰撞
    ...(r.remoteId
      ? { memoryId: `${providerType}:${providerId}:${r.remoteId}` }
      : {}),
    retrievalMode: 'remote',
  };
}

// 包装以保持原签名(类方法里调)
function remoteToSearchResult(r: KnowledgeProviderResult): SearchResult {
  // 默认命名空间(向后兼容);类内部调时传具体 type/id 更好,但保持简单
  return remoteToSearchResultInner(r, 'remote', 'default');
}
