import {
  requireAuthAccess,
  requireAdminAccess,
  AuthError,
} from '@/lib/auth/access';
import { listBuiltinMemoryRows } from '@/lib/core/db/memory/builtin';
import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { listL0Rules } from '@/lib/core/db/agentd';
import { getConfig } from '@/lib/core/kv/config';
import { cookies } from 'next/headers';

const VALID_ITEMS = [
  'config',
  'builtin_memories',
  'long_term_memories',
  'l0_rules',
] as const;

type ExportItem = (typeof VALID_ITEMS)[number];

function parseItems(raw: string | null): ExportItem[] {
  if (!raw) return [...VALID_ITEMS];
  const requested = raw.split(',').map((s) => s.trim()) as ExportItem[];
  return requested.filter((item) =>
    (VALID_ITEMS as readonly string[]).includes(item),
  );
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('key')
  );
}

function redactRecursive(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactRecursive);
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = redactRecursive(value);
      }
    }
    return result;
  }
  return obj;
}

function redactSecrets(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config));
  return redactRecursive(clone) as Record<string, unknown>;
}

/**
 * GET /api/export?items=config,builtin_memories,long_term_memories,l0_rules
 *
 * Unified customizable export. Query params:
 *   items  — comma-separated list of items to include (default: all)
 *   redact — "true" to redact bot tokens/secrets from config (default: true)
 *
 * Available items:
 *   config            — full AppConfig (models, agents, channels, etc.)
 *   builtin_memories  — AGENTS/SOUL/IDENTITY/USER persona memories
 *   long_term_memories — all long-term memories for the authenticated user
 *   l0_rules          — L0 security rules
 */
export async function GET(request: Request) {
  const cookieStore = await cookies();
  let authSession: { userId: string };
  try {
    const access = await requireAuthAccess(cookieStore);
    authSession = { userId: access.session.userId };
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    return Response.json({ error: 'Unauthorized' }, { status });
  }

  const url = new URL(request.url);
  const items = parseItems(url.searchParams.get('items'));
  const shouldRedact = url.searchParams.get('redact') !== 'false';

  if (items.length === 0) {
    return Response.json(
      {
        error: 'No valid items specified',
        available: VALID_ITEMS,
      },
      { status: 400 },
    );
  }

  const ADMIN_ITEMS: readonly string[] = [
    'config',
    'builtin_memories',
    'l0_rules',
  ];
  const needsAdmin = items.some((item) => ADMIN_ITEMS.includes(item));
  if (needsAdmin) {
    try {
      await requireAdminAccess(cookieStore);
    } catch {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const exportData: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    version: 1,
    items,
  };

  const fetchers: Promise<void>[] = [];

  if (items.includes('config')) {
    fetchers.push(
      getConfig().then((config) => {
        exportData.config = shouldRedact
          ? redactSecrets(config as Record<string, unknown>)
          : config;
      }),
    );
  }

  if (items.includes('builtin_memories')) {
    fetchers.push(
      listBuiltinMemoryRows().then((rows) => {
        exportData.builtinMemories = rows.map((r) => ({
          key: r.key,
          content: r.content,
        }));
      }),
    );
  }

  if (items.includes('long_term_memories')) {
    fetchers.push(
      listAllLongTermMemoryRows({ userId: authSession.userId }).then((rows) => {
        exportData.longTermMemories = rows.map((r) => ({
          key: (r as Record<string, unknown>).key ?? null,
          content: r.content,
          memoryType: (r as Record<string, unknown>).memoryType ?? 'fact',
          importance: (r as Record<string, unknown>).importance ?? 5,
        }));
      }),
    );
  }

  if (items.includes('l0_rules')) {
    fetchers.push(
      listL0Rules().then((rules) => {
        exportData.l0Rules = rules.map((r) => ({
          agentId: r.agentId,
          pattern: r.pattern,
          type: r.type,
          action: r.action,
          scope: r.scope,
          enabled: r.enabled,
        }));
      }),
    );
  }

  await Promise.all(fetchers);

  const filename = `agentboster-export-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
