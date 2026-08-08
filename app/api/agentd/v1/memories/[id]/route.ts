export const dynamic = 'force-dynamic';

import {
  deleteLongTermMemoryRow,
  updateLongTermMemoryRow,
} from '@/lib/core/db/memory/long-term';
import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import { invalidateMemoryCaches } from '@/lib/memory/cache-invalidation';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.memories.id');

const scopeSchema = z.object({
  task_id: z.string().optional(),
  session_id: z.string().optional(),
});

const updateMemorySchema = z.object({
  value: z.string(),
});

async function resolveMemoryOwner(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = scopeSchema.safeParse(
    Object.fromEntries(searchParams),
  );
  if (!parsed.success) {
    throw Object.assign(new Error('Invalid request'), { status: 400 });
  }
  // Identity is derived from the task/session scope, never trusted from
  // the body. A bare memory id is NOT enough — without a scope, any key
  // holder could rewrite or delete any other user's memory row.
  return resolveAgentdResourceAccess({
    taskId: parsed.data.task_id,
    sessionId: parsed.data.session_id,
  });
}

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

    const access = await resolveMemoryOwner(request);

    // updateLongTermMemoryRow with userId filters WHERE id = ? AND
    // userId = ?, so a row belonging to another user (or one that
    // vanished between requests) updates zero rows and returns null —
    // surface that as a clean 404 instead of crashing on `updated.id`.
    const updated = await updateLongTermMemoryRow(
      id,
      parsed.data.value,
      { userId: access.userId },
    );
    if (!updated) {
      return Response.json({ error: 'Memory not found' }, { status: 404 });
    }

    await invalidateMemoryCaches(access.userId);
    return Response.json({ success: true, data: { id: updated.id } });
  } catch (error) {
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('update memory failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveMemoryOwner(request);

    // deleteLongTermMemoryRow with userId filters WHERE id = ? AND userId = ?.
    const deleted = await deleteLongTermMemoryRow(id, {
      userId: access.userId,
    });
    if (!deleted) {
      return Response.json({ error: 'Memory not found' }, { status: 404 });
    }

    await invalidateMemoryCaches(access.userId);
    return Response.json({ success: true });
  } catch (error) {
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('delete memory failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
