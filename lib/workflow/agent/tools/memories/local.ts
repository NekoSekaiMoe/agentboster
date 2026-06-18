import { tool } from 'ai';
import { z } from 'zod';

import {
  createLongTermMemory,
  deleteLongTermMemory,
  getBuiltinMemorySection,
  getCurrentSessionSummary,
  listBuiltinMemorySections,
  listLongTermMemories,
  listSessionSummaries,
  searchLongTermMemories,
  setBuiltinMemorySection,
  updateLongTermMemory,
  upsertLongTermMemory,
} from '@/lib/memory';
import type { AppConfig } from '@/types/config';
import { builtinMemoryKeySchema } from '@/types/memory';
import { defineBuildInTool } from '../define';

const readMemoryInputSchema = z.object({
  scope: z.enum(['builtin', 'session', 'long_term']),
  key: builtinMemoryKeySchema.optional(),
  sessionId: z.string().uuid().optional(),
  query: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  // Default 0.05: search.ts normalises RRF scores to 0-1 (perfect double-rank-0
  // match = 1.0), so 0.05 ≈ "weak but above noise" — single-list rank-0 is 0.5,
  // single-list rank-10 ≈ 0.16, double-list rank-10 ≈ 0.32.
  minConfidence: z.number().min(0).max(1).default(0.05).optional(),
  page: z.number().int().min(1).default(1).optional(),
  pageSize: z.number().int().min(1).max(50).default(10).optional(),
});

const writeMemoryInputSchema = z.object({
  scope: z.enum(['builtin', 'long_term']),
  key: builtinMemoryKeySchema.optional(),
  content: z.string().min(1),
  memoryId: z.string().uuid().optional(),
  /**
   * Stable dotted key for long-term memories (e.g. `user.location`,
   * `project.stack`). When provided, the write goes through upsert-by-key
   * — reusing an existing row with the same key instead of creating a
   * duplicate. This matches the async extractor's write path, keeping
   * both paths in the same key domain so the same fact doesn't pile up
   * as multiple rows.
   *
   * Omit when the caller has no meaningful stable id; falls back to a
   * plain insert (key = null, no dedup).
   */
  stableKey: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/i,
      "stableKey must be dotted, e.g. 'user.location'",
    )
    .optional(),
  memoryType: z
    .enum(['fact', 'preference', 'decision', 'conversation'])
    .optional(),
  importance: z.number().int().min(1).max(10).optional(),
});

const deleteMemoryInputSchema = z.object({
  scope: z.literal('long_term').default('long_term'),
  memoryId: z.string().uuid(),
});

type ReadMemoryInput = z.infer<typeof readMemoryInputSchema>;
type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;
type DeleteMemoryInput = z.infer<typeof deleteMemoryInputSchema>;

async function executeReadMemoryStep(input: {
  sessionId: string;
  appConfig: AppConfig;
  value: ReadMemoryInput;
  userId?: string;
}) {
  'use step';

  const { sessionId, appConfig, value, userId } = input;

  switch (value.scope) {
    case 'builtin': {
      if (value.key) {
        const section = await getBuiltinMemorySection(value.key);
        return { scope: 'builtin', section };
      }

      const sections = await listBuiltinMemorySections();
      return { scope: 'builtin', sections };
    }

    case 'session': {
      const sid = value.sessionId ?? sessionId;
      if (value.keywords) {
        const summaries = await listSessionSummaries(sid);
        return { scope: 'session', sessionId: sid, summaries };
      }

      const current = await getCurrentSessionSummary(sid);
      return {
        scope: 'session',
        sessionId: sid,
        current: current
          ? {
              content: current.content,
              version: current.summaryVersion,
              createdAt: current.createdAt,
            }
          : null,
      };
    }

    case 'long_term': {
      const page = value.page ?? 1;
      const pageSize = value.pageSize ?? 10;

      if ((value.query?.trim() ?? '') || (value.keywords?.length ?? 0) > 0) {
        const results = await searchLongTermMemories({
          query: value.query,
          keywords: value.keywords,
          minConfidence: value.minConfidence ?? 0.05,
          page,
          pageSize,
          userId,
          config: appConfig,
        });

        return {
          scope: 'long_term',
          search: true,
          page,
          pageSize,
          results,
        };
      }

      const items = await listLongTermMemories({
        page,
        pageSize,
        userId,
      });

      return {
        scope: 'long_term',
        search: false,
        page,
        pageSize,
        items,
      };
    }
  }
}

async function executeWriteMemoryStep(input: {
  appConfig: AppConfig;
  value: WriteMemoryInput;
  userId?: string;
}) {
  'use step';

  const { appConfig, value, userId } = input;

  switch (value.scope) {
    case 'builtin': {
      if (!value.key) {
        throw new Error('key is required for builtin scope');
      }

      const result = await setBuiltinMemorySection(value.key, value.content);

      return {
        scope: 'builtin',
        section: result.section,
        truncated: result.truncated,
      };
    }

    case 'long_term': {
      // 1. Explicit memoryId: update an existing row by id (highest priority,
      //    preserves the original key whether null or dotted).
      if (value.memoryId) {
        const updated = await updateLongTermMemory({
          id: value.memoryId,
          content: value.content,
          config: appConfig,
        });
        if (!updated) {
          throw new Error(`Memory ${value.memoryId} not found`);
        }

        return {
          scope: 'long_term',
          action: 'updated',
          memory: updated.memory,
          indexing: updated.indexing,
        };
      }

      // 2. stableKey: upsert by (userId, key). This is the same write path
      //    the async extractor uses, so tool-written and extractor-written
      //    rows for the same fact land on the same row instead of piling
      //    up as duplicates.
      if (value.stableKey) {
        if (!userId) {
          throw new Error(
            'stableKey requires a resolved user id (write must be scoped)',
          );
        }

        const upserted = await upsertLongTermMemory({
          userId,
          key: value.stableKey,
          content: value.content,
          memoryType: value.memoryType,
          importance: value.importance,
          config: appConfig,
        });

        return {
          scope: 'long_term',
          action: upserted.created ? 'created' : 'updated',
          memory: upserted.memory,
          indexing: upserted.indexing,
        };
      }

      // 3. No key, no memoryId: plain insert. Backwards-compatible with
      //    callers that have no meaningful stable id. Resulting row has
      //    key = null and won't dedup against extractor-written rows —
      //    the tool description nudges the agent toward providing stableKey.
      const created = await createLongTermMemory({
        content: value.content,
        memoryType: value.memoryType,
        importance: value.importance,
        userId,
        config: appConfig,
      });

      return {
        scope: 'long_term',
        action: 'created',
        memory: created.memory,
        indexing: created.indexing,
      };
    }
  }
}

async function executeDeleteMemoryStep(input: {
  value: DeleteMemoryInput;
  userId?: string;
}) {
  'use step';

  const deleted = await deleteLongTermMemory(input.value.memoryId, {
    userId: input.userId,
  });

  return {
    scope: 'long_term',
    memoryId: input.value.memoryId,
    deleted: !!deleted,
  };
}

export default defineBuildInTool({
  id: 'memory',
  description:
    'Read builtin/session/long-term memories, write builtin or long-term memories, and delete long-term memories.',
  factory: async (
    _config,
    { appConfig, sessionId, allowDelegation, userId },
  ) => {
    if (!allowDelegation) {
      return null;
    }

    return {
      readMemory: tool({
        title: 'Read Memory',
        description: `Read or search memories.`,
        inputSchema: readMemoryInputSchema,
        execute: async (value) =>
          executeReadMemoryStep({
            sessionId,
            appConfig,
            value,
            userId,
          }),
      }),

      writeMemory: tool({
        title: 'Write Memory',
        description: `Persist a fact worth remembering long-term. Call this proactively whenever the conversation reveals durable information about the user or the work — do not wait for the user to say "remember this". Worth persisting: user personal information (location, timezone, language, occupation), preferences (style, habits, constraints), project configuration (tech stack, conventions), and important decisions with their rationale. Not worth persisting: transient task execution details (use task_progress for those), one-off requests, pleasantries. Long-term memory content is scoped to the current user — do not include the user's name, role, or identifier in the content; refer to the subject as "the user" or omit the subject.

When writing long-term memories, ALWAYS provide a \`stableKey\` in dotted format (e.g. \`user.location\`, \`user.timezone\`, \`project.stack\`, \`decision.architecture\`). The same fact rewritten later MUST reuse the same \`stableKey\` so the prior row is updated in place rather than duplicated. Pick keys that are stable across rewording: prefer topic-based nouns (\`user.location\`) over phrasing that mirrors a specific conversation. Omit \`stableKey\` only when no meaningful stable id exists. A parallel async extractor writes with the same key domain, so consistent keying keeps tool-written and extractor-written memories deduplicated.`,
        inputSchema: writeMemoryInputSchema,
        execute: async (value) =>
          executeWriteMemoryStep({
            appConfig,
            value,
            userId,
          }),
      }),

      deleteMemory: tool({
        title: 'Delete Long-term Memory',
        description:
          'Delete a long-term memory by memoryId. Built-in and session memories cannot be deleted.',
        inputSchema: deleteMemoryInputSchema,
        execute: async (value) =>
          executeDeleteMemoryStep({
            value,
            userId,
          }),
      }),
    };
  },
});
