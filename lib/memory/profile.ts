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

import { listLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { isGlobalProjectId } from '@/lib/memory/scope';

const PROFILE_HEADER = '# `Developer Profile`';
const PROFILE_PREAMBLE =
  "Always-on global developer profile (auto-derived from the user's stored preferences and durable personal context). Apply these consistently across every answer — code style, tone, conventions — without waiting for the user to repeat themselves. Do NOT call readMemory to re-confirm anything listed here.";

const MAX_PROFILE_ENTRIES = 12;
const MAX_IMPORTANCE_FOR_FACT = 8;

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
 */
export async function loadDeveloperProfile(
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
