/**
 * Dream proposals API — list + ratify/reject tentative memories.
 *
 * Dream Phase 2 writes findings with dream_status='tentative'; recall
 * excludes them until a user (or the auto-ratify cron pass) promotes
 * them to 'active'. This route is the human-facing review surface.
 *
 * AutoGPT analogue: the ratification loop in
 * ref/.../backend/copilot/dream/ratification.py — there a separate pass
 * flips `status=tentative` to `status=active` after a configurable
 * observation window or explicit reviewer approval. Our model is the
 * same: manual via this endpoint, OR automatic via the auto-ratify
 * cron (see /api/cron/dream/ratify) once the proposal is older than a
 * staleness threshold and has not been contradicted.
 *
 * Auth: standard cookie session (middleware-gated). All reads/writes
 * are scoped to the authenticated user — a user can only see / act on
 * their own proposals.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import {
  bulkSetTentativeStatus,
  listTentativeMemories,
} from '@/lib/core/db/memory/long-term';
import { invalidateProfileCache } from '@/lib/memory/profile';
import { invalidateRecallCache } from '@/lib/memory/recall';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.memory.dream.proposals');

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit') ?? '50'), 1),
    200,
  );

  const proposals = await listTentativeMemories({
    userId: access.user.id,
    limit,
  });

  return NextResponse.json({
    proposals: proposals.map((p) => ({
      id: p.id,
      key: p.key,
      content: p.content,
      memoryType: p.memoryType,
      importance: p.importance,
      projectId: p.projectId,
      dreamMeta: p.dreamMeta,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
    })),
    count: proposals.length,
  });
}

// POST is used for batch actions (ratify-all / reject-all) on the
// authenticated user's proposals. Single-item actions use the
// [id]/route.ts PATCH endpoint.
export async function POST(request: Request) {
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

  const body = await request.json().catch(() => ({}));
  const action = body?.action as string | undefined;
  if (action !== 'ratify-all' && action !== 'reject-all') {
    return NextResponse.json(
      { error: 'action must be "ratify-all" or "reject-all"' },
      { status: 400 },
    );
  }

  // Single bulk UPDATE scoped to (userId, dream_status='tentative') so a
  // large review queue is one round-trip. Returns the affected-row count;
  // the action-specific status (active vs contradicted) is derived from
  // `action`.
  const ratified = action === 'ratify-all';
  const processed = await bulkSetTentativeStatus({
    userId: access.user.id,
    ratified,
  });

  // Batch promotion/demotion changes which memories recall + profile see,
  // so invalidate both caches.
  invalidateRecallCache(access.user.id);
  await invalidateProfileCache(access.user.id);

  logger.info('proposals:batch_action', {
    userId: access.user.id,
    action,
    processed,
  });

  return NextResponse.json({
    action,
    processed,
  });
}
