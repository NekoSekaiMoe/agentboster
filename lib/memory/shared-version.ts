/**
 * Per-workspace shared-memory version counter (KV-backed).
 *
 * Why this exists: shared long-term memory rows (shared=true inside a
 * multi-member workspace) are visible to EVERY workspace reader — recall
 * matches them via `shared=true OR user_id=?` (see
 * buildWorkspaceVisibilityCondition in lib/core/db/memory/long-term.ts).
 * The per-user invalidation on write paths (invalidateRecallCache /
 * invalidateProfileCache / bumpMemoryVersion) only reaches the WRITER's
 * caches, so a second workspace member kept serving stale shared memories
 * until the recall-cache TTL expired.
 *
 * The fix mirrors the per-user write-gate version (see
 * lib/memory/provider/write-gate.ts): a monotonically-increasing counter
 * per workspace in the shared KV layer, bumped by the DAL on ANY
 * shared-row mutation (create/upsert/update/delete of shared rows and
 * deleteLongTermMemoriesByWorkspaceId) and read by workspace-scoped recall
 * to version its cache key. A bump makes every reader's cached entry
 * unreachable on the next read — no TTL wait, works across instances.
 *
 * Personal (non-shared) cache behavior is unchanged: the version is only
 * read when a recall is workspace-scoped, and only shared rows bump it.
 *
 * Bundle safety: statically imports only the KV shim (bundle-safe, see
 * lib/core/kv/index.ts) and the logger. No node:* / next/server imports.
 */

import { get as kvGet, incr } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('memory.shared_version');

/** Version counters live in their own key space; only incr writes numbers. */
export function sharedMemoryVersionKey(workspaceId: string): string {
  return `shared_memory_version:${workspaceId}`;
}

/**
 * Read the current shared-memory version for a workspace.
 *
 * Fail-soft to 0, mirroring readMemoryVersion's rationale: the version's
 * only use is cache-key validation, so the worst case of a missing/dirty
 * value is a cache-key mismatch → a fresh DB read (the SAFE direction).
 * Throwing here would make the recall read path hard-depend on the KV
 * counter, so errors are logged and swallowed instead.
 */
export async function readSharedMemoryVersion(
  workspaceId: string,
): Promise<number> {
  const key = sharedMemoryVersionKey(workspaceId);
  try {
    const raw = await kvGet(key);
    if (raw === null || raw === undefined) return 0;
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isFinite(parsed)) return parsed;
    logger.warn('version:unparseable', {
      workspaceId,
      key,
      raw: String(raw).slice(0, 64),
    });
    return 0;
  } catch (error) {
    logger.warn('version:read_failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Atomically increment the workspace's shared-memory version. Called from
 * the DAL (lib/core/db/memory/long-term.ts) on every shared-row mutation so
 * no caller can forget it — including routes that hit the DAL directly
 * (e.g. workspace hard-delete / shared-pool teardown).
 *
 * Best-effort: a failed bump must not fail the memory write itself. The
 * consequence of a missed bump is pre-fix behavior (other members serve
 * stale shared memories until TTL) — never worse. Logged so the silent
 * path stays observable.
 */
export async function bumpSharedMemoryVersion(
  workspaceId: string,
): Promise<number> {
  try {
    return await incr(sharedMemoryVersionKey(workspaceId));
  } catch (error) {
    logger.warn('version:bump_failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
