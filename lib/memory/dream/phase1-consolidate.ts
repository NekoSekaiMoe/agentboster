/**
 * Phase 1 — Consolidation.
 *
 * Clusters recent episodic memories for a user and merges overlapping
 * entries into canonical facts, RECORDING provenance (which source
 * memories a consolidated fact came from).
 *
 * Relationship to `lib/memory/compact.ts`:
 * - `compact.ts` is the existing merge pass (MERGE/DELETE/KEEP) with no
 *   provenance, no near-duplicate pre-filter, no audit trail.
 * - This module is Dream Phase 1: it wraps the same LLM consolidation
 *   with (a) bigram near-dup pre-filtering so the model doesn't see the
 *   same fact phrased twice, (b) an operations list returned to the
 *   caller (Dream orchestrator) instead of applied inline, and (c)
 *   provenance recorded per operation so `apply.ts` + `dream_runs` can
 *   audit WHERE each fact came from.
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/orchestrator.py
 * ::_run_consolidate + schemas.ConsolidatedFact.
 *
 * IMPORTANT: Phase 1 returns operations; it does NOT write to the DB.
 * The orchestrator passes them to phase3-sanitize, then to apply.ts.
 * Keeping the read/decide/write split is what lets sanitize reject
 * near-duplicate proposals BEFORE any write happens.
 */

import { generateObject } from 'ai';
import { z } from 'zod';

import { resolveLanguageModel } from '@/lib/ai';
import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

import { dedupeNearDuplicateContents } from './bigram';
import type { DreamOperation } from './types';
import { computeUsageAdjustments } from './usage-signals';

const logger = createLogger('memory.dream.phase1');

const MAX_GROUP_SIZE = 15;
const MIN_GROUP_SIZE_FOR_CONSOLIDATE = 2;

const consolidationSchema = z.object({
  actions: z.array(
    z.object({
      type: z.enum(['MERGE', 'DELETE', 'KEEP']),
      sourceIds: z
        .array(z.string())
        .describe('IDs of memories being merged or deleted'),
      mergedKey: z
        .string()
        .optional()
        .describe('Stable dotted key for the merged memory (MERGE only)'),
      mergedContent: z
        .string()
        .optional()
        .describe('Consolidated canonical content (MERGE only)'),
      mergedType: z
        .enum(['fact', 'preference', 'decision', 'conversation'])
        .optional(),
      mergedImportance: z.number().int().min(1).max(10),
      // Model confidence in the consolidation. Required for MERGE so apply
      // can record provenance quality. Trimmed to [0,1] defensively.
      confidence: z.number().min(0).max(1),
    }),
  ),
});

type MemoryRow = {
  id: string;
  userId: string | null;
  projectId: string | null;
  key: string | null;
  content: string;
  memoryType: string;
  importance: number;
  sourceKind?: string | null;
  recallCount?: number | null;
  recallQueryHashes?: string[] | null;
  lastRecalledAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function extractKeyPrefix(key: string): string {
  const dotIndex = key.indexOf('.');
  if (dotIndex <= 0) return key;
  return key.slice(0, dotIndex);
}

/**
 * Build the composite group key so rows from different projects never
 * share a consolidation call. Each project owns its own concept namespace
 * (the same prefix in two projects describes unrelated facts), so merging
 * them would feed the LLM a confused grab-bag and let one project bleed
 * into another's canonical rows.
 */
function buildGroupKey(projectId: string | null, prefix: string): string {
  return `${projectId ?? '__null__'}\u0000${prefix}`;
}

/**
 * Group memories by (projectId, key prefix) so the LLM only ever sees
 * related facts from ONE project in one call. Keyless memories land
 * in `__keyless__` and are skipped — they have no stable identity to
 * merge against. (Same policy as compact.ts.)
 *
 * The returned group KEY is composite (projectId + prefix) to keep
 * projects isolated; callers that need the pure prefix (e.g. the
 * consolidateBatch prompt) read it from group members instead.
 */
function groupMemoriesByPrefix(
  memories: MemoryRow[],
): Map<string, { prefix: string; members: MemoryRow[] }> {
  const groups = new Map<string, { prefix: string; members: MemoryRow[] }>();
  for (const mem of memories) {
    if (!mem.key) continue;
    const prefix = extractKeyPrefix(mem.key);
    const groupKey = buildGroupKey(mem.projectId, prefix);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.members.push(mem);
    } else {
      groups.set(groupKey, { prefix, members: [mem] });
    }
  }
  return groups;
}

/**
 * Drop near-duplicate contents within a group BEFORE sending to the LLM.
 *
 * Rationale: when the extractor has run several times it can produce
 * near-identical rows (same fact, slightly different wording) under
 * different keys. Sending them all to the model wastes tokens and
 * produces merges that paraphrase rather than consolidate. Pre-filtering
 * with bigram Jaccard keeps only the first of each cluster.
 *
 * Returns the deduped members plus a per-rejection map for the audit log.
 */
function dedupeGroupMembers(members: MemoryRow[]): {
  kept: MemoryRow[];
  rejectedDuplicates: Array<{ id: string; duplicateOf: string }>;
} {
  const { accepted, rejected } = dedupeNearDuplicateContents({
    contents: members.map((m) => m.content),
  });
  return {
    kept: accepted.map((i) => members[i]),
    rejectedDuplicates: rejected.map((r) => ({
      id: members[r.index].id,
      duplicateOf: members[r.duplicateOf].id,
    })),
  };
}

/**
 * Run Phase 1 consolidation for one user.
 *
 * @returns the proposed operations (not yet applied) + provenance info.
 *          The orchestrator passes these to phase3 then apply.ts.
 */
export async function consolidatePhase(input: {
  userId: string;
  config: AppConfig;
  /**
   * Pre-fetched active memories for the user. When omitted, phase1 does
   * the listAllLongTermMemoryRows call itself. The orchestrator passes
   * the SAME rows it gives phase2 so the per-user memory store is
   * scanned once per Dream run instead of once per phase.
   */
  memories?: MemoryRow[];
}): Promise<{
  operations: DreamOperation[];
  stats: {
    groupsProcessed: number;
    consolidated: number;
    deleted: number;
    kept: number;
    rejectedDuplicates: number;
  };
}> {
  const modelId = input.config.models?.model;
  if (!modelId) {
    logger.warn('phase1:no_model');
    return {
      operations: [],
      stats: {
        groupsProcessed: 0,
        consolidated: 0,
        deleted: 0,
        kept: 0,
        rejectedDuplicates: 0,
      },
    };
  }

  const allMemories =
    input.memories ??
    ((await listAllLongTermMemoryRows({
      userId: input.userId,
    })) as MemoryRow[]);

  const groups = groupMemoriesByPrefix(allMemories);
  const operations: DreamOperation[] = [];
  let consolidated = 0;
  let deleted = 0;
  let kept = 0;
  let rejectedDuplicates = 0;
  let groupsProcessed = 0;

  // Deterministic usage-feedback pass (OpenClaw deep-ranking analogue:
  // memory graduates because it kept being useful). No LLM involved —
  // recall frequency + query diversity move importance one step per run.
  // Emitted BEFORE the LLM batches so phase3's mutation budget and the
  // apply path treat them like any other operation.
  let adjusted = 0;
  for (const adjustment of computeUsageAdjustments(allMemories)) {
    adjusted += 1;
    operations.push({
      type: 'ADJUST_IMPORTANCE',
      memoryId: adjustment.memoryId,
      importance: adjustment.importance,
      reason: adjustment.reason,
    });
  }

  for (const [, { prefix, members }] of groups) {
    if (members.length < MIN_GROUP_SIZE_FOR_CONSOLIDATE) {
      kept += members.length;
      continue;
    }

    // Pre-filter near-duplicates so the model sees distinct facts only.
    const { kept: dedupedMembers, rejectedDuplicates: rejects } =
      dedupeGroupMembers(members);
    rejectedDuplicates += rejects.length;
    // Drop the rejected duplicates up front — they will be consolidated
    // into the surviving member of their cluster. We emit a CONSOLIDATE
    // op per rejected dup so apply.ts can mark them superseded.
    for (const reject of rejects) {
      const dupOf = members.find((m) => m.id === reject.duplicateOf);
      if (dupOf) {
        operations.push({
          type: 'SUPERSEDE',
          oldMemoryId: reject.id,
          newMemoryId: reject.duplicateOf,
        });
        deleted += 1;
      }
    }

    if (dedupedMembers.length < MIN_GROUP_SIZE_FOR_CONSOLIDATE) {
      kept += dedupedMembers.length;
      continue;
    }

    // Process the deduped group in batches of MAX_GROUP_SIZE.
    for (
      let offset = 0;
      offset < dedupedMembers.length;
      offset += MAX_GROUP_SIZE
    ) {
      const batch = dedupedMembers.slice(offset, offset + MAX_GROUP_SIZE);
      if (batch.length < MIN_GROUP_SIZE_FOR_CONSOLIDATE) {
        kept += batch.length;
        continue;
      }
      groupsProcessed += 1;

      try {
        const batchOps = await consolidateBatch({
          prefix,
          members: batch,
          userId: input.userId,
          modelId,
          config: input.config,
        });
        operations.push(...batchOps.operations);
        consolidated += batchOps.stats.consolidated;
        deleted += batchOps.stats.deleted;
        kept += batchOps.stats.kept;
      } catch (error) {
        logger.warn('phase1:batch_failed', {
          prefix,
          batchOffset: offset,
          memberCount: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
        kept += batch.length;
      }
    }
  }

  logger.info('phase1:done', {
    userId: input.userId,
    total: allMemories.length,
    groupsProcessed,
    adjusted,
    consolidated,
    deleted,
    kept,
    rejectedDuplicates,
  });

  return {
    operations,
    stats: {
      groupsProcessed,
      consolidated,
      deleted,
      kept,
      rejectedDuplicates,
    },
  };
}

/**
 * Ask the model how to consolidate ONE batch within a group.
 * Returns operations (CONSOLIDATE / DELETE) — KEEP produces no operation.
 */
async function consolidateBatch(input: {
  prefix: string;
  members: MemoryRow[];
  userId: string;
  modelId: string;
  config: AppConfig;
}): Promise<{
  operations: DreamOperation[];
  stats: { consolidated: number; deleted: number; kept: number };
}> {
  const model = resolveLanguageModel(input.modelId, input.config);
  const memberIds = new Set(input.members.map((m) => m.id));

  const memoriesBlock = input.members
    .map((m, i) => {
      const recalls = m.recallCount ?? 0;
      const contexts = Array.isArray(m.recallQueryHashes)
        ? m.recallQueryHashes.length
        : 0;
      const usage =
        recalls > 0
          ? ` [recalled ${recalls}× across ${contexts} contexts]`
          : ' [never recalled]';
      const taint =
        m.sourceKind === 'tool_observed' ? ' [source=tool/web]' : '';
      return `${i + 1}. [id=${m.id}] [key=${m.key ?? '(none)'}] [type=${m.memoryType}] [importance=${m.importance}]${usage}${taint}\n   ${m.content}`;
    })
    .join('\n');

  const prompt = `You are a memory consolidation engine for a developer-focused AI assistant. Given a group of related memories for one user, decide how to merge them into canonical facts.

Concept group: "${input.prefix}"

Memories:
${memoriesBlock}

For each action choose one:
- MERGE: combine 2+ semantically overlapping memories into ONE consolidated canonical statement. Provide a stable dotted key (e.g. "user.location", "project.lang"), the merged content, type, importance (1-10), and confidence (0-1). The sourceIds will be superseded by the new fact.
- DELETE: remove a memory that is fully redundant or outdated. Provide its sourceId.
- KEEP: leave as-is. Provide its sourceId.

Rules:
- Only use the exact [id=...] values shown above. Never invent IDs.
- Every memory ID must appear in exactly one action.
- Prefer MERGE over DELETE when each adds unique detail.
- Preserve the highest importance from merged sources.
- Usage signals matter: memories annotated "recalled N× across M contexts" have PROVEN utility — preserve them and never delete them for redundancy alone. Memories annotated "never recalled" are weaker merge/delete candidates.
- Memories annotated [source=tool/web] came from external content, not the user: keep confidence at or below 0.6 when merging them and never raise their importance above 6.
- Write merged content from the assistant's perspective about "the user" or "the project".
- Keep merged content concise — no longer than the longest source.
- Confidence reflects how clearly the sources support the merged claim (1.0 = directly stated, 0.5 = inferred).`;

  const result = await generateObject({
    model,
    schema: consolidationSchema,
    schemaName: 'DreamConsolidation',
    prompt,
  });

  const operations: DreamOperation[] = [];
  let consolidated = 0;
  let deleted = 0;
  let kept = 0;

  for (const action of result.object.actions) {
    // Drop hallucinated IDs the model returned that aren't in this batch.
    const validIds = action.sourceIds.filter((id) => memberIds.has(id));
    const dropped = action.sourceIds.length - validIds.length;
    if (dropped > 0) {
      logger.warn('phase1:ignored_out_of_group_ids', {
        type: action.type,
        droppedCount: dropped,
        requested: action.sourceIds.length,
      });
    }

    switch (action.type) {
      case 'MERGE': {
        if (
          !action.mergedContent ||
          !action.mergedKey ||
          validIds.length < 2 ||
          action.mergedImportance === undefined ||
          action.confidence === undefined
        ) {
          kept += validIds.length;
          break;
        }
        // Capture the projectId of the sources so the new fact lands in the
        // same scope. All members of a group share the same prefix; if they
        // somehow span projects, keep the first source's project.
        const projectId =
          input.members.find((m) => m.id === validIds[0])?.projectId ?? null;

        operations.push({
          type: 'CONSOLIDATE',
          sourceMemoryIds: validIds,
          mergedKey: action.mergedKey,
          projectId: projectId ?? undefined,
          mergedContent: action.mergedContent,
          mergedType: action.mergedType ?? 'fact',
          mergedImportance: action.mergedImportance,
          confidence: action.confidence,
        });
        consolidated += 1;
        break;
      }
      case 'DELETE': {
        operations.push({
          type: 'DELETE',
          memoryIds: validIds,
        });
        deleted += validIds.length;
        break;
      }
      case 'KEEP':
      default: {
        kept += validIds.length;
        break;
      }
    }
  }

  return {
    operations,
    stats: { consolidated, deleted, kept },
  };
}
