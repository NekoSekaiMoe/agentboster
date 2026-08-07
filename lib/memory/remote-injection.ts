/**
 * 远程/外部记忆注入 helper —— host 侧预取,转 PackItem 传入 workflow。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 5。
 *
 * 为什么需要:host 侧(lib/chat/index.ts)调用 buildInitialContextMessages 前,
 * 把 knowledge 库的远程 provider 搜索结果预取为 PackItem,通过 options.extraRecallItems
 * 传入。这样 fetch/vault/node:dns 等留在 host 侧,不进 workflow bundle。
 *
 * taint gate:knowledge 结果的 sourceKind 按 documentSourceType 推断(见
 * knowledgeHitToPackItem):用户上传/录入 = user_asserted(进 Trusted 段),
 * connector 自动抓取的 url = tool_observed(进 Unverified 段)。
 */

import { searchKnowledge } from '@/lib/knowledge';
import { knowledgeHitToPackItem } from '@/lib/knowledge/utils';
import type { KnowledgeAccessScope } from '@/lib/core/db/knowledge';
import type { PackItem } from '@/lib/memory/provider/context-packer';
import type { AppConfig } from '@/types/config';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('memory.remote-injection');

/**
 * 带整体超时的 promise 包装。超时或 reject 时返回 fallback(fail-open)。
 *
 * reviewer D1:远程预取不能无限期阻塞主对话关键路径。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
   * 访问作用域(final-review B1):必须传,控制知识库可见性。
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
      // final-review B1:必须透传 access,默认以当前 userId 消费者身份访问。
      // 不传会被 searchKnowledge 默认成 'team' 全量 → 多租户跨用户泄露。
      access: options.access ?? { userId: options.userId, isAdmin: false },
    });
    return rows
      .map(knowledgeHitToPackItem)
      .filter((item): item is PackItem => item.text.length > 0);
  } catch (error) {
    // reviewer B4:fail-open 仍返回空数组,但用 logger.warn 记录异常 + 上下文,
    // 区分"无命中"与"检索/配置异常",避免静默吞错。
    logger.warn('collect:remote_search_failed', {
      userId: options.userId,
      query: options.query.slice(0, 80),
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
