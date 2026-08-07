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
import { invalidateMemoryCaches } from '@/lib/memory/cache-invalidation';
import { isNearDuplicate } from '@/lib/memory/dream/bigram';
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
  sourceKind: z
    .enum(['user_asserted', 'assistant_observed', 'tool_observed'])
    .describe(
      'Provenance of this fact. user_asserted = the user stated it directly in their own message. tool_observed = it came from tool output, file contents, web pages, or other external content shown in the transcript. assistant_observed = anything inferred by the assistant rather than explicitly stated.',
    ),
  triggerPhrases: z
    .array(z.string().min(2).max(60))
    .max(3)
    .optional()
    .describe(
      '2-3 short phrases describing WHEN this fact becomes relevant again (e.g. "deploy failure", "code style question", "发布部署"). Used by a lexical prefilter to surface the memory on future turns. Omit for one-off task details.',
    ),
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
 * The extractor LLM cannot be trusted with provenance: a fact it read in
 * tool output is one prompt-injection away from being labeled
 * `user_asserted` (the highest trust class). Model classifications may
 * only be DOWNGRADED, never upgraded — so anything the extractor claims
 * the user asserted directly is stored as `assistant_observed`. Genuine
 * user assertions enter via the manual create path
 * (createDreamMemoryAction), which never passes through this resolver.
 */
function resolveExtractedSourceKind(
  kind: 'user_asserted' | 'assistant_observed' | 'tool_observed',
): 'assistant_observed' | 'tool_observed' {
  return kind === 'user_asserted' ? 'assistant_observed' : kind;
}

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
  /**
   * Optional caller user record (or just its model preferences). When
   * provided, the per-user model override takes precedence over the
   * global default. When omitted, the global default is used (and looked
   * up lazily by the caller's host context if needed).
   */
  user?: { modelPreferences?: { model?: string } | null } | null;
  /**
   * Optional project scope for extracted memories. When set, all
   * project-relevant facts (tech stack, conventions, paths) are written
   * under this project_id so project-scoped recall and the project-
   * aggregate view can find them. Null/undefined = global (the
   * historical default). The LLM prompt still decides whether a fact is
   * global ("user.location") or project-scoped ("project.tech_stack"),
   * but the storage scope is fixed per extraction pass.
   */
  projectId?: string | null;
}): Promise<{ extracted: number; created: number; updated: number }> {
  const rows = await getVisibleSessionMessages(input.sessionId);
  if (rows.length === 0) {
    return { extracted: 0, created: 0, updated: 0 };
  }

  const conversationText = buildConversationContext(rows);
  if (!conversationText.trim()) {
    return { extracted: 0, created: 0, updated: 0 };
  }

  const modelId =
    input.user?.modelPreferences?.model ?? input.config.models?.model;
  if (!modelId) {
    logger.warn('extract:no_model', { sessionId: input.sessionId });
    return { extracted: 0, created: 0, updated: 0 };
  }

  // Scope the existing-memory list to the SAME project scope the writes
  // below target (current project + global, via buildProjectScopeCondition).
  // Previously this fetched ALL of the user's memories across every project,
  // so the LLM would see foreign [key]s and emit UPDATE/DELETE that the
  // scoped write helpers silently no-op'd — leaving stale rows behind and
  // creating duplicate facts in the current scope.
  const existing = await listLongTermMemories({
    page: 1,
    pageSize: 100,
    userId: input.userId,
    projectIdScope: input.projectId,
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

CRITICAL — deduplication across write paths:
The existing memories list may contain rows whose [key] is \`null\` or a placeholder like \`__manual__\` — these were written by the user or by the in-conversation writeMemory tool without a stable key. Before emitting ADD, scan the content of ALL existing rows (including keyless ones) for semantic overlap with the fact you are about to add. If the same fact is already present under a keyless row, emit UPDATE with a fresh dotted key you invent for it (e.g. \`user.location\`) rather than ADD — this migrates the fact into the stable-key domain so future writes deduplicate cleanly. Reserve ADD strictly for facts that are not already captured in any form.

CRITICAL — recall-loop prevention:
The conversation may contain injected blocks titled "[Relevant Long-term Memories]", "[Triggered Memories]", or "[Conversation Summary]". These are ALREADY-STORED memories and summaries being re-shown to the assistant, not new information. Never extract them: do not ADD them as new facts, and do not UPDATE an existing memory merely because its own text reappeared in one of these blocks. Only facts the user or tools introduced in THIS conversation count.

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

  // Deterministic recall-loop / duplicate guard: an ADD whose content
  // near-duplicates ANY existing active memory is folded to a skip, no
  // matter what the model decided. This is the structural backstop for
  // the prompt-level recall-loop rule above — injected memory text that
  // the model mistakenly re-extracts can never re-enter the store as a
  // new row (OpenClaw: "a fact recalled one hundred times stays one
  // fact"). Threshold 0.8 is stricter than Dream's 0.6 merge threshold:
  // we only want to catch restatements, not related-but-distinct facts.
  const existingContents = existing.map((m) => m.content);
  const filteredItems: typeof items = [];
  for (const item of items) {
    if (item.action !== 'ADD') {
      filteredItems.push(item);
      continue;
    }
    const isRestatement = existingContents.some((content) =>
      isNearDuplicate(item.content, content, 0.8),
    );
    if (isRestatement) {
      noop += 1;
      logger.info('extract:recall_loop_guard', {
        sessionId: input.sessionId,
        key: item.key,
      });
      continue;
    }
    filteredItems.push(item);
  }

  for (const item of filteredItems) {
    try {
      switch (item.action) {
        case 'ADD': {
          await upsertLongTermMemory({
            userId: input.userId,
            key: item.key,
            content: item.content,
            memoryType: item.memoryType,
            importance: item.importance,
            sourceKind: resolveExtractedSourceKind(item.sourceKind),
            triggerPhrases: item.triggerPhrases,
            projectId: input.projectId,
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
            sourceKind: resolveExtractedSourceKind(item.sourceKind),
            triggerPhrases: item.triggerPhrases,
            projectId: input.projectId,
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
            projectId: input.projectId,
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

  // Phase 3 失效链修复(reviewer phase3 B1):ADD/UPDATE 走 upsertLongTermMemory
  // 已 bump,但 DELETE 走 deleteLongTermMemoryByKey(裸 DAL)不 bump。统一在末尾
  // 失效 + bump,覆盖 DELETE 路径,与 dream/apply 一致。
  if (created + updated + deleted > 0) {
    await invalidateMemoryCaches(input.userId);
  }

  return { extracted: items.length, created, updated };
}
