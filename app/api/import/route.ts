import { readAuthSessionFromCookies } from '@/lib/auth';
import { requireAdminAccess } from '@/lib/auth/access';
import {
  upsertBuiltinMemoryRow,
} from '@/lib/core/db/memory/builtin';
import { createL0Rule } from '@/lib/core/db/agentd';
import { patchConfig } from '@/lib/core/kv/config';
import {
  upsertLongTermMemory,
} from '@/lib/memory/long-term';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';

const logger = createLogger('api.import');

interface ImportPayload {
  version?: number;
  items?: string[];
  config?: Record<string, unknown>;
  builtinMemories?: Array<{ key: string; content: string }>;
  longTermMemories?: Array<{
    key?: string | null;
    content: string;
    memoryType?: string;
    importance?: number;
  }>;
  l0Rules?: Array<{
    agentId?: string;
    pattern: string;
    type: string;
    action: string;
    scope?: string;
    enabled?: boolean;
  }>;
}

const BUILTIN_KEYS = ['AGENTS', 'SOUL', 'IDENTITY', 'USER'] as const;

/**
 * POST /api/import
 *
 * Unified customizable import. Accepts the JSON body produced by
 * GET /api/export and selectively restores each section.
 *
 * Body: the export JSON. Only sections present in the body are imported.
 * Query params:
 *   items — comma-separated list to restrict which sections are applied
 *           (default: apply all sections present in the body)
 *   merge — "true" to merge config with existing (default: true)
 *           "false" to fully replace config
 *
 * Requires admin role for config and l0_rules. Regular users can import
 * their own memories.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ImportPayload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = new URL(request.url);
  const itemsParam = url.searchParams.get('items');
  const allowedItems = itemsParam
    ? new Set(itemsParam.split(',').map((s) => s.trim()))
    : null;
  const mergeConfig = url.searchParams.get('merge') !== 'false';

  const results: Record<string, { success: boolean; count?: number; error?: string }> = {};

  if (body.config && (!allowedItems || allowedItems.has('config'))) {
    try {
      await requireAdminAccess(authSession);
      if (mergeConfig) {
        await patchConfig(body.config);
      } else {
        const { setConfig } = await import('@/lib/core/kv/config');
        await setConfig(body.config);
      }
      results.config = { success: true };
    } catch (err) {
      results.config = {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to import config',
      };
    }
  }

  if (
    body.builtinMemories &&
    (!allowedItems || allowedItems.has('builtin_memories'))
  ) {
    try {
      await requireAdminAccess(authSession);
      let count = 0;
      for (const mem of body.builtinMemories) {
        if (
          !(BUILTIN_KEYS as readonly string[]).includes(mem.key) ||
          !mem.content
        ) {
          continue;
        }
        await upsertBuiltinMemoryRow(
          mem.key as (typeof BUILTIN_KEYS)[number],
          mem.content.slice(0, 4096),
        );
        count++;
      }
      results.builtinMemories = { success: true, count };
    } catch (err) {
      results.builtinMemories = {
        success: false,
        error: err instanceof Error ? err.message : 'Failed',
      };
    }
  }

  if (
    body.longTermMemories &&
    (!allowedItems || allowedItems.has('long_term_memories'))
  ) {
    let count = 0;
    let failed = 0;
    for (const mem of body.longTermMemories) {
      if (!mem.content) continue;
      try {
        if (mem.key) {
          await upsertLongTermMemory({
            userId: authSession.userId,
            key: mem.key,
            content: mem.content,
            memoryType: mem.memoryType as 'fact' | 'preference' | 'decision' | 'conversation' | undefined,
            importance: mem.importance,
          });
        } else {
          const { createLongTermMemory } = await import(
            '@/lib/memory/long-term'
          );
          await createLongTermMemory({
            content: mem.content,
            userId: authSession.userId,
            memoryType: mem.memoryType as 'fact' | 'preference' | 'decision' | 'conversation' | undefined,
            importance: mem.importance,
          });
        }
        count++;
      } catch {
        failed++;
      }
    }
    results.longTermMemories = {
      success: failed === 0,
      count,
      ...(failed > 0 ? { error: `${failed} entries failed` } : {}),
    };
  }

  if (body.l0Rules && (!allowedItems || allowedItems.has('l0_rules'))) {
    try {
      await requireAdminAccess(authSession);
      let count = 0;
      for (const rule of body.l0Rules) {
        if (!rule.pattern || !rule.type || !rule.action) continue;
        await createL0Rule({
          agentId: rule.agentId,
          pattern: rule.pattern,
          type: rule.type,
          action: rule.action,
          scope: rule.scope,
          enabled: rule.enabled,
        });
        count++;
      }
      results.l0Rules = { success: true, count };
    } catch (err) {
      results.l0Rules = {
        success: false,
        error: err instanceof Error ? err.message : 'Failed',
      };
    }
  }

  logger.info('import:done', {
    userId: authSession.userId,
    results,
  });

  return Response.json({ ok: true, results });
}
