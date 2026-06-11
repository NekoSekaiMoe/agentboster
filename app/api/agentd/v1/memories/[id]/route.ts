import { db } from '@/lib/core/db';
import * as schema from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const logger = createLogger('api.agentd.memories.id');

const updateMemorySchema = z.object({
  value: z.string(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = updateMemorySchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    await db
      .update(schema.longTermMemories)
      .set({ content: parsed.data.value, updatedAt: new Date() })
      .where(eq(schema.longTermMemories.id, id));

    return Response.json({ success: true });
  } catch (error) {
    logger.error('update memory failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    await db
      .delete(schema.longTermMemories)
      .where(eq(schema.longTermMemories.id, id));

    return Response.json({ success: true });
  } catch (error) {
    logger.error('delete memory failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
