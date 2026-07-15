import { generateObject } from 'ai';
import { z } from 'zod';

import { resolveLanguageModel } from '@/lib/ai';
import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import {
  deleteLongTermMemory,
  upsertLongTermMemory,
} from '@/lib/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('memory.compact');

const MAX_GROUP_SIZE = 15;
const MIN_GROUP_SIZE_FOR_COMPACT = 2;

const compactResultSchema = z.object({
  actions: z.array(
    z.object({
      type: z.enum(['MERGE', 'DELETE', 'KEEP']),
      sourceIds: z
        .array(z.string())
        .describe('IDs of memories being merged or deleted'),
      mergedKey: z
        .string()
        .optional()
        .describe('Stable key for the merged memory (MERGE only)'),
      mergedContent: z
        .string()
        .optional()
        .describe('Consolidated content (MERGE only)'),
      mergedType: z
        .enum(['fact', 'preference', 'decision', 'conversation'])
        .optional(),
      mergedImportance: z.number().int().min(1).max(10).optional(),
    }),
  ),
});

type MemoryRow = {
  id: string;
  userId: string | null;
  key: string | null;
  content: string;
  memoryType: string;
  importance: number;
};

function extractKeyPrefix(key: string): string {
  const dotIndex = key.indexOf('.');
  if (dotIndex <= 0) return key;
  return key.slice(0, dotIndex);
}

function groupMemoriesByPrefix(memories: MemoryRow[]) {
  const groups = new Map<string, MemoryRow[]>();

  for (const mem of memories) {
    const prefix = mem.key ? extractKeyPrefix(mem.key) : '__keyless__';
    const group = groups.get(prefix) ?? [];
    group.push(mem);
    groups.set(prefix, group);
  }

  return groups;
}

/**
 * Compact long-term memories for a user by merging semantically
 * overlapping entries within the same concept group.
 *
 * Pipeline:
 *  1. Load all memories for the user.
 *  2. Group by key prefix (e.g., "user.*" → group "user").
 *     Keyless memories go into a "__keyless__" bucket.
 *  3. For groups with 2+ members, ask an LLM to decide: MERGE
 *     overlapping entries into one, DELETE redundant ones, or KEEP.
 *  4. Apply actions: upsert merged memories, delete consumed sources.
 *
 * Returns statistics about what changed.
 */
export async function compactLongTermMemories(input: {
  userId: string;
  config: AppConfig;
}): Promise<{ merged: number; deleted: number; kept: number }> {
  const modelId = input.config.models?.model;
  if (!modelId) {
    logger.warn('compact:no_model');
    return { merged: 0, deleted: 0, kept: 0 };
  }

  const allMemories = await listAllLongTermMemoryRows({
    userId: input.userId,
  });

  if (allMemories.length < MIN_GROUP_SIZE_FOR_COMPACT) {
    return { merged: 0, deleted: 0, kept: 0 };
  }

  const groups = groupMemoriesByPrefix(allMemories as MemoryRow[]);

  let totalMerged = 0;
  let totalDeleted = 0;
  let totalKept = 0;

  for (const [prefix, members] of groups) {
    if (members.length < MIN_GROUP_SIZE_FOR_COMPACT) {
      totalKept += members.length;
      continue;
    }

    // Process the whole group in batches of MAX_GROUP_SIZE rather than only
    // the first slice. Without this, members beyond the first MAX_GROUP_SIZE
    // are silently skipped on every run and never compacted or counted.
    for (let offset = 0; offset < members.length; offset += MAX_GROUP_SIZE) {
      const batch = members.slice(offset, offset + MAX_GROUP_SIZE);
      if (batch.length < MIN_GROUP_SIZE_FOR_COMPACT) {
        // A trailing batch of one has nothing to merge against; keep it.
        totalKept += batch.length;
        continue;
      }

      try {
        const result = await compactGroup({
          prefix,
          members: batch,
          userId: input.userId,
          modelId,
          config: input.config,
        });
        totalMerged += result.merged;
        totalDeleted += result.deleted;
        totalKept += result.kept;
      } catch (error) {
        logger.warn('compact:group_failed', {
          prefix,
          batchOffset: offset,
          memberCount: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
        totalKept += batch.length;
      }
    }
  }

  logger.info('compact:done', {
    userId: input.userId,
    total: allMemories.length,
    merged: totalMerged,
    deleted: totalDeleted,
    kept: totalKept,
  });

  return { merged: totalMerged, deleted: totalDeleted, kept: totalKept };
}

async function compactGroup(input: {
  prefix: string;
  members: MemoryRow[];
  userId: string;
  modelId: string;
  config: AppConfig;
}): Promise<{ merged: number; deleted: number; kept: number }> {
  const model = resolveLanguageModel(input.modelId, input.config);

  // The set of IDs the model is allowed to touch. Anything it returns that
  // is not in here is a hallucinated / out-of-group ID and must be ignored —
  // otherwise an untrusted model could delete memories outside this group
  // (or another user's, though userId-scoped delete already blocks that).
  const memberIds = new Set(input.members.map((m) => m.id));

  const memoriesBlock = input.members
    .map(
      (m, i) =>
        `${i + 1}. [id=${m.id}] [key=${m.key ?? '(none)'}] [type=${m.memoryType}] [importance=${m.importance}]\n   ${m.content}`,
    )
    .join('\n');

  const prompt = `You are a memory compaction engine. Given a group of related memories for one user, decide how to consolidate them.

Concept group: "${input.prefix}"

Memories in this group:
${memoriesBlock}

For each action, choose one:
- MERGE: combine 2+ memories that overlap semantically into one consolidated entry. Provide the merged content, a stable dotted key, type, and importance. The sourceIds are the IDs of memories being merged (they will be replaced).
- DELETE: remove a memory that is completely redundant, outdated, or contradicted by another in the group. Provide sourceIds of memories to delete.
- KEEP: leave a memory as-is. Provide its ID in sourceIds.

Rules:
- Only use the exact [id=...] values shown above. Never invent IDs.
- Every memory ID must appear in exactly one action.
- Prefer MERGE over DELETE when content overlaps but each adds unique detail.
- Preserve the highest importance value from merged sources.
- Write merged content from the assistant's perspective about "the user".
- Keep merged content concise — no longer than the longest source.`;

  const result = await generateObject({
    model,
    schema: compactResultSchema,
    schemaName: 'MemoryCompaction',
    prompt,
  });

  let merged = 0;
  let deleted = 0;
  let kept = 0;

  const deletedIds = new Set<string>();

  for (const action of result.object.actions) {
    // Drop any ID the model returned that is not a real member of this group.
    const validSourceIds = action.sourceIds.filter((id) => memberIds.has(id));
    const droppedCount = action.sourceIds.length - validSourceIds.length;
    if (droppedCount > 0) {
      logger.warn('compact:ignored_out_of_group_ids', {
        type: action.type,
        droppedCount,
        requested: action.sourceIds.length,
      });
    }

    try {
      switch (action.type) {
        case 'MERGE': {
          if (
            !action.mergedContent ||
            !action.mergedKey ||
            validSourceIds.length < 2
          ) {
            kept += validSourceIds.length;
            break;
          }

          // Write the merged memory FIRST and learn its row id. If mergedKey
          // collides with an existing source row, upsert updates that same
          // row — so we must exclude the merged row's id from the subsequent
          // delete sweep, otherwise we would delete the memory we just wrote.
          const upserted = await upsertLongTermMemory({
            userId: input.userId,
            key: action.mergedKey,
            content: action.mergedContent,
            memoryType: action.mergedType,
            importance: action.mergedImportance,
            config: input.config,
          });
          const mergedRowId = upserted.memory.id;

          let deletedThisAction = 0;
          for (const id of validSourceIds) {
            if (id === mergedRowId) continue; // never delete the merge target
            if (deletedIds.has(id)) continue;
            await deleteLongTermMemory(id, { userId: input.userId });
            deletedIds.add(id);
            deletedThisAction += 1;
          }
          merged += 1;
          deleted += deletedThisAction;
          break;
        }
        case 'DELETE': {
          for (const id of validSourceIds) {
            if (!deletedIds.has(id)) {
              await deleteLongTermMemory(id, { userId: input.userId });
              deletedIds.add(id);
              deleted += 1;
            }
          }
          break;
        }
        case 'KEEP':
        default: {
          kept += validSourceIds.length;
          break;
        }
      }
    } catch (error) {
      logger.warn('compact:action_failed', {
        type: action.type,
        sourceIds: validSourceIds,
        error: error instanceof Error ? error.message : String(error),
      });
      kept += validSourceIds.length;
    }
  }

  return { merged, deleted, kept };
}
