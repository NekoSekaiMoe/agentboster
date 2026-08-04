/**
 * Shared cache-invalidation + reindex helpers for memory write paths.
 *
 * Every route that mutates long-term memory rows (Dream review UI, Dream
 * apply flow, proposal API) must drop the same set of derived caches and
 * re-index the touched row so it becomes searchable. These used to be
 * copied into each call site and had already started to drift (different
 * error handling, different config loading) — keep exactly one copy here.
 */

import { getConfig } from '@/lib/core/kv/config';
import { reindexLongTermMemory } from '@/lib/memory/long-term';
import { invalidateProfileCache } from '@/lib/memory/profile';
import { invalidateRecallCache } from '@/lib/memory/recall';
import { invalidateTriggerCache } from '@/lib/memory/triggers';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('memory.invalidation');

/** Drop every memory-derived cache for a user after a memory write. */
export async function invalidateMemoryCaches(userId: string) {
  invalidateRecallCache(userId);
  invalidateTriggerCache(userId);
  await invalidateProfileCache(userId);
}

/**
 * Fire-and-forget reindex so a written/edited row becomes searchable.
 *
 * Dream-written rows go through the DAL directly and skip chunk indexing,
 * so a ratified/edited row must be (re)indexed to become searchable.
 * Callers that already hold the config (e.g. the Dream apply flow) pass
 * it through; otherwise it is loaded here. Indexing failure degrades
 * search visibility for one row — it must never fail the caller.
 */
export async function scheduleReindex(memoryId: string, config?: AppConfig) {
  const resolved = config ?? (await getConfig().catch(() => null)) ?? undefined;
  reindexLongTermMemory({ memoryId, config: resolved }).catch((error) => {
    logger.warn('memory:reindex_failed', {
      memoryId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
