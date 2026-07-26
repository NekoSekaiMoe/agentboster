/**
 * Memory scope helpers — the single source of truth for how `projectId`
 * partitions long-term memory.
 *
 * Background: long_term_memories grew an optional `projectId` column so
 * memories can be scoped per project/workspace (ref_revica.md §2.1
 * "project-aggregate view" + §2.6 "global developer profile"). To keep
 * the (userId, projectId, key) UNIQUE constraint meaningful even for
 * "global / cross-project" memories, we never store NULL — we store the
 * GLOBAL_PROJECT_ID sentinel. That way one user has exactly one global
 * "tech_stack" row AND one per-project "tech_stack" row, instead of the
 * SQL NULL-vs-NULL trap where two global rows could silently coexist.
 *
 * All DB write paths MUST normalize through `resolveProjectId()` so the
 * rest of the codebase never has to remember the sentinel. Read paths
 * accept either form via `isGlobalProjectId()` / `sameProjectScope()`.
 */

/**
 * Sentinel stored in `long_term_memories.project_id` for memories that
 * are NOT scoped to any specific project (the historical default before
 * the column existed). Chosen to be unlikely to collide with a real
 * workspace.project_id (those are user-controlled slugs/ids).
 */
export const GLOBAL_PROJECT_ID = '__global__';

/**
 * Normalize a possibly-null projectId into the value that should be
 * stored in the DB. Callers that don't care about project scoping pass
 * undefined/null and get the global sentinel back — so the historical
 * "no projectId" write path keeps working, just stored as the sentinel
 * instead of NULL.
 *
 * Always run user-supplied ids through this before any DB write or
 * cache-key computation.
 */
export function resolveProjectId(projectId?: string | null): string {
  const trimmed = projectId?.trim();
  if (!trimmed) return GLOBAL_PROJECT_ID;
  return trimmed;
}

/** True if this projectId value represents the global (unscoped) memory. */
export function isGlobalProjectId(projectId?: string | null): boolean {
  return resolveProjectId(projectId) === GLOBAL_PROJECT_ID;
}

/**
 * Do two projectId values refer to the same memory scope? Treats null /
 * undefined / '' / GLOBAL_PROJECT_ID as equivalent (all = global), per
 * the resolveProjectId normalization.
 */
export function sameProjectScope(
  a?: string | null,
  b?: string | null,
): boolean {
  return resolveProjectId(a) === resolveProjectId(b);
}

/**
 * Human-readable label for UI rendering. Returns the project id as-is
 * for real projects, or a fixed "Global" label for the sentinel.
 */
export function describeProjectScope(projectId?: string | null): string {
  if (isGlobalProjectId(projectId)) return 'Global';
  return projectId ?? 'Global';
}
