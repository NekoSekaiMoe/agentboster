/**
 * Post-conversation memory extraction (the "MemoryWorker" pass).
 *
 * After a chat session completes (web workflow finalizeRunStep) or an
 * agentd task finishes, this module runs a single LLM call over the
 * conversation to extract durable facts the in-conversation writeMemory
 * tool calls missed. Extraction is best-effort: any failure (LLM error,
 * JSON parse error, single-row upsert failure) is logged and skipped
 * without aborting the whole batch.
 *
 * Dedup model: the LLM emits a stable `key` per fact
 * (e.g. "user.location", "project.tech_stack"). We upsert by
 * (userId, key), so re-running extraction over an updated conversation
 * updates the same row instead of creating duplicates. The schema's
 * unique index on (userId, key) backs this.
 */

import { generateObject } from 'ai';
import { z } from 'zod';

import { resolveLanguageModel } from '@/lib/ai';
import { getVisibleSessionMessages } from '@/lib/core/db/chat';
import {
  type PersistedMessageRecord,
  type PersistedMessagePayload,
} from '@/lib/chat/message-utils';
import {
  deleteLongTermMemoryByKey,
  listLongTermMemories,
  upsertLongTermMemory,
} from '@/lib/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('memory.extract');

const MAX_MESSAGES = 200;
const MAX_TOOL_OUTPUT_CHARS = 600;
const MAX_TEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24000;

const extractionItemSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'Stable dotted identifier for this fact, e.g. "user.location", "project.tech_stack", "preference.response_style". Use the same key for the same conceptual fact across runs so it can be upserted.',
    ),
  content: z
    .string()
    .min(1)
    .describe(
      'The fact content, written from the assistant perspective. Do not include the user name or role; refer to "the user" or omit the subject.',
    ),
  memoryType: z.enum(['fact', 'preference', 'decision', 'conversation']),
  importance: z.number().int().min(1).max(10),
  action: z
    .enum(['ADD', 'UPDATE', 'DELETE', 'NOOP'])
    .describe(
      'Decision for this fact. ADD = new fact, use a brand-new key. UPDATE = refine/correct an existing fact, reuse its key with new content. DELETE = the existing fact is wrong/outdated/contradicted, reference its key to remove. NOOP = the existing fact already captures this, do nothing.',
    ),
});

const extractionResultSchema = z.object({
  items: z.array(extractionItemSchema),
});

/**
 * Build a compact text rendering of a conversation for the extractor LLM.
 *
 * - user messages → `user: ...`
 * - assistant text → `assistant: ...`
 * - assistant tool calls → `tool[name]: <input summary> => <output summary>`
 *
 * Tool inputs/outputs are truncated; file attachments are dropped. The
 * goal is enough signal for the LLM to spot durable facts without
 * blowing past the model's context window on long sessions.
 */
export function buildConversationContext(
  rows: PersistedMessageRecord[],
): string {
  const lines: string[] = [];

  for (const row of rows.slice(0, MAX_MESSAGES)) {
    const text = renderRow(row);
    if (text) {
      lines.push(text);
    }
  }

  let joined = lines.join('\n');
  if (joined.length > MAX_CONTEXT_CHARS) {
    joined = `${joined.slice(0, MAX_CONTEXT_CHARS)}\n…[truncated]`;
  }
  return joined;
}

function renderRow(row: PersistedMessageRecord): string {
  const payload = row.payload as PersistedMessagePayload;
  const role = row.role;

  if (role === 'user') {
    const text = (payload.text ?? '').trim();
    if (!text) return '';
    return `user: ${truncate(text, MAX_TEXT_CHARS)}`;
  }

  if (role === 'assistant') {
    const text = (payload.text ?? '').trim();
    return text ? `assistant: ${truncate(text, MAX_TEXT_CHARS)}` : '';
  }

  if (role === 'tool') {
    const toolName = payload.toolName ?? 'unknown';
    const input = serializeShort(payload.input);
    const output = serializeShort(payload.output);
    const state = payload.toolState ?? 'input-available';

    if (state === 'output-available' || state === 'output-error') {
      return `tool[${toolName}]: ${input} => ${truncate(output, MAX_TOOL_OUTPUT_CHARS)}`;
    }
    return `tool[${toolName}]: ${input}`;
  }

  return '';
}

function serializeShort(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Extract durable memories from a session's conversation and upsert them.
 *
 * Pipeline:
 *   1. Fetch session messages from the DB.
 *   2. Render them to a compact text context.
 *   3. Load the user's existing long-term memories so the LLM can see
 *      what's already known (avoids re-stating the same fact differently).
 *   4. One generateObject call → structured list of items with stable keys.
 *   5. Upsert each item by (userId, key).
 *
 * Failures inside step 5 are isolated per-item; LLM/parse failures bubble
 * up to the caller, which is expected to log and swallow.
 */
export async function extractMemoriesFromSession(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
}): Promise<{ extracted: number; created: number; updated: number }> {
  const rows = await getVisibleSessionMessages(input.sessionId);
  if (rows.length === 0) {
    return { extracted: 0, created: 0, updated: 0 };
  }

  const conversationText = buildConversationContext(rows);
  if (!conversationText.trim()) {
    return { extracted: 0, created: 0, updated: 0 };
  }

  const modelId = input.config.models?.model;
  if (!modelId) {
    logger.warn('extract:no_model', { sessionId: input.sessionId });
    return { extracted: 0, created: 0, updated: 0 };
  }

  const existing = await listLongTermMemories({
    page: 1,
    pageSize: 100,
    userId: input.userId,
  });
  const existingBlock =
    existing.length > 0
      ? existing
          .map((m, i) => {
            const key = 'key' in m && typeof m.key === 'string' ? m.key : '';
            return `${i + 1}. ${key ? `[${key}] ` : ''}${m.content}`;
          })
          .join('\n')
      : '(no existing memories)';

  const model = resolveLanguageModel(modelId, input.config);

  const prompt = `You are a memory extractor. After a conversation ends, you scan the transcript and decide what durable facts to persist, update, or remove for this user.

Worth persisting:
- user personal info (location, timezone, language, occupation)
- user preferences (style, communication habits, constraints)
- project / environment configuration (tech stack, naming conventions, file paths)
- important decisions and their rationale

Not worth persisting:
- transient task execution details
- one-off requests and chit-chat
- information already captured in the existing memories list (use NOOP)

Conversation:
${conversationText}

Existing memories for this user (use the bracketed [key] to reference them):
${existingBlock}

Emit an "items" array. For each item, choose one action:

- ADD: a brand-new durable fact. Invent a new dotted key that does not appear above. Put the fact in "content".
- UPDATE: a fact that refines, extends, or corrects an existing one. REUSE the existing memory's key. Put the merged/corrected content in "content".
- DELETE: an existing memory that is now wrong, outdated, or contradicted by the conversation. Reference its existing key. The "content" field may be empty or a short reason for deletion.
- NOOP: the conversation mentions a fact already captured accurately. Reference the existing key to skip it. The "content" field may be empty.

Leave the array empty if nothing is worth changing.`;

  const result = await generateObject({
    model,
    schema: extractionResultSchema,
    schemaName: 'MemoryExtraction',
    prompt,
  });

  const items = result.object.items;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let noop = 0;

  for (const item of items) {
    try {
      switch (item.action) {
        case 'ADD': {
          await upsertLongTermMemory({
            userId: input.userId,
            key: item.key,
            content: item.content,
            memoryType: item.memoryType,
            importance: item.importance,
            config: input.config,
          });
          created += 1;
          break;
        }
        case 'UPDATE': {
          const result = await upsertLongTermMemory({
            userId: input.userId,
            key: item.key,
            content: item.content,
            memoryType: item.memoryType,
            importance: item.importance,
            config: input.config,
          });
          if (result.created) {
            // Existing key not found despite UPDATE — treat as ADD to avoid losing info.
            created += 1;
          } else {
            updated += 1;
          }
          break;
        }
        case 'DELETE': {
          const removed = await deleteLongTermMemoryByKey({
            userId: input.userId,
            key: item.key,
          });
          if (removed) {
            deleted += 1;
          } else {
            // Nothing to delete — silently skip.
          }
          break;
        }
        case 'NOOP':
        default: {
          noop += 1;
          break;
        }
      }
    } catch (err) {
      logger.warn('extract:apply_failed', {
        sessionId: input.sessionId,
        key: item.key,
        action: item.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('extract:done', {
    sessionId: input.sessionId,
    userId: input.userId,
    total: items.length,
    created,
    updated,
    deleted,
    noop,
  });

  return { extracted: items.length, created, updated };
}
