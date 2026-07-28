/**
 * Single-proposal ratification endpoint.
 *
 * PATCH /api/memory/dream/proposals/{id} with body
 *   { "ratified": true }  → promote to active (joins recall)
 *   { "ratified": false } → demote to contradicted (excluded + never re-proposed)
 * Optional: { "note": "reason" } recorded in dreamMeta.reviewNote for audit.
 *
 * Returns 404 when the id isn't a tentative memory owned by the caller —
 * this prevents using this endpoint to probe for arbitrary memory ids
 * (the row exists but isn't tentative → 404 rather than 403 to avoid
 * leaking existence).
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { ratifyLongTermMemory } from '@/lib/core/db/memory/long-term';
import { invalidateProfileCache } from '@/lib/memory/profile';
import { invalidateRecallCache } from '@/lib/memory/recall';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.memory.dream.proposals.id');

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body?.ratified !== 'boolean') {
    return NextResponse.json(
      { error: 'body must include boolean "ratified"' },
      { status: 400 },
    );
  }
  const note =
    typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;

  const updated = await ratifyLongTermMemory({
    id,
    userId: access.user.id,
    ratified: body.ratified,
    note,
  });

  if (!updated) {
    // Either the id doesn't exist, isn't owned by this user, or isn't
    // currently tentative. Return 404 uniformly to avoid leaking existence.
    return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  }

  // Caches that depend on the active set must be dropped so the next
  // prompt build sees the ratification immediately.
  invalidateRecallCache(access.user.id);
  await invalidateProfileCache(access.user.id);

  logger.info('proposal:ratified', {
    userId: access.user.id,
    memoryId: id,
    ratified: body.ratified,
  });

  return NextResponse.json({
    id: updated.id,
    dreamStatus: updated.dreamStatus,
    dreamMeta: updated.dreamMeta,
  });
}
