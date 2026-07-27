/**
 * Project-aggregate memory view (ref_revica.md §2.1).
 *
 * The memory tab historically showed a flat list of long-term memories with
 * no project dimension — every memory mixed together. With the new
 * `project_id` column on long_term_memories, memories are partitioned by
 * project. This module is the read-side aggregation that turns raw rows
 * into a browsable, project-grouped document so the user can see "what does
 * the agent know about project X" at a glance.
 *
 * Design choices:
 * - Pure read path. No caching layer of its own; recall.ts already caches
 *   the vector/keyword search results and this view is for humans browsing,
 *   not for every-turn injection (the developer profile handles always-on).
 * - Groups by projectId (resolved through scope.ts so GLOBAL_PROJECT_ID
 *   becomes the friendly "Global" label). Within each group, memories are
 *   sorted by importance then recency — same weight function as the profile
 *   so the two views stay consistent.
 * - Does NOT synthesize / summarize via an LLM. The aggregate view is just
 *   a structured presentation of stored facts. LLM-summarized project docs
 *   are a deliberate non-goal here — they would compete with the developer
 *   profile and SOUL for prompt real estate, and would drift from the
 *   underlying rows the moment a new memory is written.
 */

import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import {
  GLOBAL_PROJECT_ID,
  describeProjectScope,
  resolveProjectId,
} from '@/lib/memory/scope';

export interface ProjectMemoryEntry {
  id: string;
  content: string;
  memoryType: 'fact' | 'preference' | 'decision' | 'conversation';
  importance: number;
  updatedAt: Date;
}

export interface ProjectMemoryGroup {
  /** Raw projectId as stored (resolved sentinel for global). */
  projectId: string;
  /** Human-readable label ("Global" or the raw project id). */
  label: string;
  /** True for the global / cross-project scope. UI may render it first. */
  isGlobal: boolean;
  memories: ProjectMemoryEntry[];
}

function sortByWeight(a: ProjectMemoryEntry, b: ProjectMemoryEntry) {
  // Preferences first, then decisions (they tend to be high-signal), then
  // importance, then recency. Mirrors the developer-profile ordering so a
  // user moving between the two views sees a consistent sort.
  const typeRank = (t: ProjectMemoryEntry['memoryType']) =>
    t === 'preference' ? 0 : t === 'decision' ? 1 : 2;
  const aRank = typeRank(a.memoryType);
  const bRank = typeRank(b.memoryType);
  if (aRank !== bRank) return aRank - bRank;
  if (b.importance !== a.importance) return b.importance - a.importance;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

/**
 * Build the project-aggregate view for a user. Returns one group per
 * distinct projectId, with the global group first (most memories live
 * there for users predating project scoping) and project groups sorted
 * alphabetically thereafter for stable UI.
 *
 * Pass `projectIdScope` to limit to a single project (plus its global
 * baseline) — used by the per-project drill-down view.
 */
export async function buildProjectMemoryAggregate(options: {
  userId?: string;
  projectIdScope?: string | null;
}): Promise<ProjectMemoryGroup[]> {
  const rows = await listAllLongTermMemoryRows({
    userId: options.userId,
    projectIdScope: options.projectIdScope,
  });

  const byProject = new Map<string, ProjectMemoryEntry[]>();
  for (const row of rows) {
    const resolved = resolveProjectId(row.projectId);
    let bucket = byProject.get(resolved);
    if (!bucket) {
      bucket = [];
      byProject.set(resolved, bucket);
    }
    bucket.push({
      id: row.id,
      content: row.content,
      memoryType: row.memoryType,
      importance: row.importance,
      updatedAt: row.updatedAt,
    });
  }

  const groups: ProjectMemoryGroup[] = [];
  for (const [projectId, memories] of byProject) {
    memories.sort(sortByWeight);
    groups.push({
      projectId,
      label: describeProjectScope(projectId),
      isGlobal: projectId === GLOBAL_PROJECT_ID,
      memories,
    });
  }

  // Stable order: global first, then alphabetical by label. Keeps the UI
  // from flickering as memories are added/updated.
  groups.sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

/**
 * List the distinct projects a user has memories for. Lightweight
 * companion to buildProjectMemoryAggregate for sidebar / filter UIs that
 * only need the project list (not every memory row).
 */
export async function listUserProjectScopes(
  userId?: string,
): Promise<ProjectMemoryGroup[]> {
  const groups = await buildProjectMemoryAggregate({ userId });
  // Strip the memories array — callers only need the scope metadata.
  return groups.map((g) => ({ ...g, memories: [] }));
}
