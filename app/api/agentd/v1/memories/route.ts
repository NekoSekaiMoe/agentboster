export const dynamic = 'force-dynamic';

import { invalidateMemoryCaches } from '@/lib/memory/cache-invalidation';
import { searchLongTermMemories } from '@/lib/memory/long-term';
import { createLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.memories');

const getMemoriesSchema = z.object({
  agent_id: z.string().optional(),
  keywords: z.string().optional(),
  limit: z.coerce.number().int().positive().default(100),
  task_id: z.string().optional(),
  session_id: z.string().optional(),
});

const writeMemoriesSchema = z.object({
  task_id: z.string().optional(),
  session_id: z.string().optional(),
  memories: z.array(
    z.object({
      AgentID: z.string(),
      Key: z.string(),
      Value: z.string(),
      Source: z.string().optional(),
    }),
  ),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = getMemoriesSchema.safeParse(
      Object.fromEntries(searchParams),
    );

    if (!parsed.success) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { keywords, limit } = parsed.data;
    const keywordList = keywords
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (!keywordList?.length) {
      return Response.json([]);
    }

    const results = await searchLongTermMemories({
      query: keywordList.join(' '),
      minConfidence: 0.05,
      pageSize: limit,
    });

    const memories = results.map((r, i) => ({
      ID: r.memoryId,
      AgentID: '',
      Key: `result-${i}`,
      Value: r.content,
      Source: 'long-term',
      CreatedAt: new Date().toISOString(),
      AccessCount: 0,
    }));

    return Response.json(memories);
  } catch (error) {
    logger.error('get memories failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = writeMemoriesSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { memories } = parsed.data;

    const rows = memories.map((m) => ({
      userId: 'agentd',
      content: `[${m.Key}] ${m.Value}`,
      memoryType: 'fact' as const,
      importance: 5,
    }));

    if (rows.length > 0) {
      await createLongTermMemoryRows(rows);
      // Phase 3 失效链修复(reviewer phase3 B2):裸 DAL 不失效,显式调
      // invalidateMemoryCaches 让 recall/trigger/profile cache + packer version 失效。
      await invalidateMemoryCaches('agentd');
    }

    return Response.json({ success: true });
  } catch (error) {
    logger.error('write memories failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
