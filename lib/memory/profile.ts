/**
 * Developer profile — the "global developer profile" (ref_revica.md §2.6).
 *
 * Distinct from `recall.ts`:
 * - recall is **query-driven**: it surfaces memories semantically related
 *   to the user's *latest message*. If the user says "fix this bug", recall
 *   won't fetch their code-style preferences because the query has nothing
 *   to do with style.
 * - the profile is **always-on**: durable preferences and long-running
 *   project context are injected into every system prompt as a stable
 *   "who the user is / how they like things" block, so the model never
 *   "forgets" the user's preferred style just because the current turn
 *   isn't about style.
 *
 * Source = long_term_memories with `memoryType='preference'` (and a small
 * allowance of high-importance `fact`s about the user), scoped to the
 * GLOBAL project (project_id = GLOBAL_PROJECT_ID). We deliberately do NOT
 * include project-scoped memories here — those are the project-aggregate
 * view's job and would bloat the always-on block.
 */

import { del, get, set } from '@/lib/core/kv';
import { listLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { isGlobalProjectId } from '@/lib/memory/scope';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('memory.profile');

const PROFILE_HEADER = '# `Developer Profile`';
const PROFILE_PREAMBLE =
  "Always-on global developer profile (auto-derived from the user's stored preferences and durable personal context). Apply these consistently across every answer — code style, tone, conventions — without waiting for the user to repeat themselves. Do NOT call readMemory to re-confirm anything listed here.";

const MAX_PROFILE_ENTRIES = 12;
const MAX_IMPORTANCE_FOR_FACT = 8;

/**
 * Redis cache TTL for the always-on profile.
 *
 * The profile is durable (changes only on memory writes), so a long TTL
 * is safe and pays off across every system-prompt build. Mirrors
 * AutoGPT's `understanding:{user_id}` 48h cache. We invalidate eagerly
 * on writes via `invalidateProfileCache()` — see long-term.ts upserts.
 *
 * Kept slightly shorter than AutoGPT's 48h to bound staleness if an
 * eager invalidation is ever missed (e.g. a memory written via a path
 * that bypasses the DAL).
 */
const PROFILE_CACHE_TTL_SECONDS = 24 * 60 * 60;

function profileCacheKey(userId: string): string {
  return `profile:${userId}`;
}

/**
 * Invalidate the cached profile for a user (or all users).
 *
 * Call from every long_term_memories write path that could affect the
 * profile — preference/fact writes, Dream consolidation, manual edits.
 * The long-term.ts upsert/delete helpers already invalidate recallCache;
 * they will also call this once profile cache ships.
 */
export async function invalidateProfileCache(userId?: string): Promise<void> {
  if (!userId) {
    // No way to scan+delete all profile:* keys portably across the KV
    // backends (pg-backend has no SCAN). Treat undefined userId as a
    // no-op rather than a dangerous global flush — callers MUST pass
    // the specific userId. Logged so the silent path is visible.
    logger.warn('invalidate:no_user_id_skipped');
    return;
  }
  try {
    await del(profileCacheKey(userId));
  } catch (error) {
    // Cache invalidation is best-effort — a stale entry just means the
    // next prompt build uses a slightly outdated profile until TTL expiry.
    logger.warn('invalidate:failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ProfileEntry {
  content: string;
  memoryType: 'fact' | 'preference' | 'decision' | 'conversation';
  importance: number;
  updatedAt: Date;
}

function sortByWeight(a: ProfileEntry, b: ProfileEntry) {
  // Preferences first (they are the point of the profile), then importance,
  // then recency. Keeps the block stable across turns so the model anchors
  // on consistent wording.
  const aTypeRank = a.memoryType === 'preference' ? 0 : 1;
  const bTypeRank = b.memoryType === 'preference' ? 0 : 1;
  if (aTypeRank !== bTypeRank) return aTypeRank - bTypeRank;
  if (b.importance !== a.importance) return b.importance - a.importance;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

/**
 * Load the always-on developer profile for a user: their global (non-project)
 * preferences plus the most important durable facts about them.
 *
 * Returns a flat list, already sorted by weight. Empty when the user has no
 * qualifying memories yet.
 *
 * Caching: backed by Redis (24h TTL) keyed per-user. The DB scan is the
 * same cost on every prompt build, and the profile changes rarely — so
 * caching is a clear win across serverless / multi-instance deployments
 * where a process-local Map (like recallCache) would not be shared.
 * Invalidation is eager via `invalidateProfileCache()` on memory writes.
 */
export async function loadDeveloperProfile(
  userId: string,
): Promise<ProfileEntry[]> {
  // Cache lookup first. JSON payload mirrors the on-disk shape; we accept
  // the small risk that a schema change could mismatch and fall through
  // to a fresh DB read + overwrite.
  try {
    const cached = await get(profileCacheKey(userId));
    if (cached) {
      const parsed = parseCachedProfile(cached);
      if (parsed) return parsed;
    }
  } catch (error) {
    logger.warn('cache_read_failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const entries = await loadDeveloperProfileFromDb(userId);

  // Best-effort cache write — failure here is non-fatal (next call just
  // hits the DB again).
  try {
    await set(profileCacheKey(userId), serializeProfileForCache(entries), {
      ex: PROFILE_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn('cache_write_failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return entries;
}

async function loadDeveloperProfileFromDb(
  userId: string,
): Promise<ProfileEntry[]> {
  // Pull a generous window then trim in-memory: the user_project_updated_idx
  // index serves the ORDER BY, and the type + importance filters are cheap
  // post-hoc. We only want GLOBAL memories (project-scoped ones belong to
  // the per-project view, not the always-on profile).
  const rows = await listLongTermMemoryRows({
    userId,
    // Only the global scope. Pass the sentinel directly so
    // buildProjectScopeCondition takes the "only global" branch.
    projectIdScope: '__global__',
    limit: 60,
  });

  const entries: ProfileEntry[] = rows
    .filter((row) => {
      // Defensive: listLongTermMemoryRows already filters to global when
      // given the sentinel, but make the intent explicit in case the
      // sentinel constant ever changes value.
      if (!isGlobalProjectId(row.projectId)) return false;
      // Taint gate: tool_observed memories came from tool/web output,
      // not from the user. They must never enter the always-on profile
      // — auto-injecting unverified external content into EVERY system
      // prompt is exactly the memory-poisoning vector provenance
      // classification exists to close (OpenClaw quarantine-by-tier).
      if (row.sourceKind === 'tool_observed') return false;
      if (row.memoryType === 'preference') return true;
      if (
        row.memoryType === 'fact' &&
        row.importance >= MAX_IMPORTANCE_FOR_FACT
      ) {
        return true;
      }
      return false;
    })
    .map((row) => ({
      content: row.content,
      memoryType: row.memoryType,
      importance: row.importance,
      updatedAt: row.updatedAt,
    }));

  entries.sort(sortByWeight);
  return entries.slice(0, MAX_PROFILE_ENTRIES);
}

/**
 * Render the developer profile as a system-prompt section. Returns null when
 * the profile is empty so the caller can skip the section entirely (keeps
 * the prompt clean for brand-new users with no memories yet).
 */
export async function buildDeveloperProfileSection(
  userId?: string,
): Promise<string | null> {
  if (!userId) return null;
  const entries = await loadDeveloperProfile(userId);
  if (entries.length === 0) return null;

  const lines = entries.map((entry, index) => {
    return `${index + 1}. ${entry.content}`;
  });

  return [PROFILE_HEADER, PROFILE_PREAMBLE, '', ...lines].join('\n');
}

// ─── Cache (de)serialization ────────────────────────────────────────
//
// Redis stores strings; we serialize with JSON. `updatedAt` becomes an
// ISO string on the wire and is parsed back to Date on read. Both helpers
// are defensive: a malformed cache entry returns null / throws nothing,
// causing the caller to fall through to a fresh DB read.

type SerializedProfileEntry = Omit<ProfileEntry, 'updatedAt'> & {
  updatedAt: string;
};

function serializeProfileForCache(entries: ProfileEntry[]): string {
  const serialized: SerializedProfileEntry[] = entries.map((e) => ({
    content: e.content,
    memoryType: e.memoryType,
    importance: e.importance,
    updatedAt: e.updatedAt.toISOString(),
  }));
  return JSON.stringify(serialized);
}

function parseCachedProfile(raw: unknown): ProfileEntry[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const entries: ProfileEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const content = obj.content;
      const memoryType = obj.memoryType;
      const importance = obj.importance;
      const updatedAt = obj.updatedAt;
      if (typeof content !== 'string') continue;
      if (
        memoryType !== 'fact' &&
        memoryType !== 'preference' &&
        memoryType !== 'decision' &&
        memoryType !== 'conversation'
      ) {
        continue;
      }
      if (typeof importance !== 'number') continue;
      if (typeof updatedAt !== 'string') continue;
      const ts = Date.parse(updatedAt);
      if (!Number.isFinite(ts)) continue;
      entries.push({
        content,
        memoryType,
        importance,
        updatedAt: new Date(ts),
      });
    }
    return entries;
  } catch {
    return null;
  }
}
