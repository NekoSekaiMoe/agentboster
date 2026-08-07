/**
 * 远程/外部记忆注入 helper —— host 侧预取,转 PackItem 传入 workflow。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 5。
 *
 * 为什么需要:host 侧(lib/chat/index.ts)调用 buildInitialContextMessages 前,
 * 把 knowledge 库的远程 provider 搜索结果预取为 PackItem,通过 options.extraRecallItems
 * 传入。这样 fetch/vault/node:dns 等留在 host 侧,不进 workflow bundle。
 *
 * taint gate:所有 knowledge 结果固定 sourceKind=tool_observed(文档库未经 user 确认),
 * 进 recall block 的 Unverified 段。见 §1.2.1。
 */

import { searchKnowledge } from '@/lib/knowledge';
import type { KnowledgeAccessScope } from '@/lib/core/db/knowledge';
import type { KnowledgeSearchRow } from '@/lib/core/db/knowledge';
import type { LongTermMemorySourceKind } from '@/lib/core/db/memory/long-term';
import type { PackItem } from '@/lib/memory/provider/context-packer';
import type { AppConfig } from '@/types/config';

export interface RemoteInjectionOptions {
  userId: string;
  query: string;
  agentId?: string;
  /** 命中条数上限。默认 3(避免知识库结果淹没个人记忆)。 */
  limit?: number;
  /** 最低 finalScore 阈值。默认 0.2(过滤明显不相关)。 */
  minConfidence?: number;
  config?: AppConfig;
  /**
   * 访问作用域(final-review B1):必颍传,控制知识库可见性。
   * 不传会被 searchKnowledge 默认成 'team' 全量(无 user 过滤),
   * 多租户场景会跨用户泄露记忆。
   */
  access?: KnowledgeAccessScope;
}

/**
 * 预取 knowledge 库搜索结果,转成可注入的 PackItem 数组。
 *
 * fail-open:任何错误(网络/配置缺失/空结果)返回 [],不阻塞主对话流程。
 */
export async function collectRemoteMemoryItems(
  options: RemoteInjectionOptions,
): Promise<PackItem[]> {
  try {
    const rows = await searchKnowledge({
      query: options.query,
      agentId: options.agentId,
      limit: options.limit ?? 3,
      minConfidence: options.minConfidence ?? 0.2,
      config: options.config,
      // final-review B1:必颍透传 access,默认以当前 userId 消者身份访问。
      // 不传会被 searchKnowledge 默认成 'team' 全量 → 多租户跨用户泄露。
      access: options.access ?? { userId: options.userId, isAdmin: false },
    });
    return rows.map(knowledgeRowToPackItem);
  } catch {
    // fail-open:远程挂了不应阻塞主对话
    return [];
  }
}

function knowledgeRowToPackItem(row: KnowledgeSearchRow): PackItem {
  const sourceKind: LongTermMemorySourceKind = 'tool_observed';
  // S3 防御:score clamp 到 [0,1],content trim 防空负贡献
  const rawScore = Number.isFinite(row.finalScore)
    ? Math.max(0, Math.min(1, row.finalScore))
    : 0.5;
  const content = (row.content ?? '').trim();
  return {
    // trim 后若为空,填占位避免 packer 丢空条目进预算
    text: content || '[empty knowledge chunk]',
    score: rawScore,
    sourceKind,
    source: 'knowledge',
    // chunkId 作 memoryId;加 'kb:' 前缀命名空间化,避跨 provider 碰撞(reviewer S1)
    memoryId: `kb:${row.chunkId}`,
  };
}
