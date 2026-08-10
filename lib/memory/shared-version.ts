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
 * Outcome of reading the workspace's shared-memory version.
 *
 * `{ ok: false }` means the KV read FAILED (or the stored value was
 * unparseable) — deliberately distinct from a legitimate
 * `{ ok: true, version: 0 }` (no shared write has bumped the counter yet).
 * The distinction matters: recall entries cached under version 0 exist in
 * practice, so collapsing a read failure into `0` would make the recall
 * cache key match those entries during a KV outage and serve stale shared
 * memories — the unsafe direction. Callers must skip the workspace cache
 * entirely (no read, no write) on `ok: false` while still running the DB
 * recall.
 */
export type SharedMemoryVersionRead =
  | { ok: true; version: number }
  | { ok: false };

/**
 * Read the current shared-memory version for a workspace.
 *
 * Never throws: the recall read path must not hard-depend on the KV
 * counter. Errors are logged and reported as `{ ok: false }` so the caller
 * can bypass the workspace cache instead of risking a stale hit.
 */
export async function readSharedMemoryVersion(
  workspaceId: string,
): Promise<SharedMemoryVersionRead> {
  const key = sharedMemoryVersionKey(workspaceId);
  try {
    const raw = await kvGet(key);
    if (raw === null || raw === undefined) return { ok: true, version: 0 };
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isFinite(parsed)) return { ok: true, version: parsed };
    logger.warn('version:unparseable', {
      workspaceId,
      key,
      raw: String(raw).slice(0, 64),
    });
    return { ok: false };
  } catch (error) {
    logger.warn('version:read_failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
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
