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
        description: `Persist a fact worth remembering long-term. Call this proactively whenever the conversation reveals durable information about the user or the work — do not wait for the user to say "remember this". Worth persisting: user personal information (location, timezone, language, occupation), preferences (style, habits, constraints), project configuration (tech stack, conventions), and important decisions with their rationale. Not worth persisting: transient task execution details (use task_progress for those), one-off requests, pleasantries. Long-term memory content is scoped to the current user — do not include the user's name, role, or identifier in the content; refer to the subject as "the user" or omit the subject.`,
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
