/**
 * Single-proposal review endpoint.
 *
 * PATCH /api/memory/dream/proposals/{id}
 *   { "ratified": true }  → promote to active (joins recall)
 *   { "ratified": false } → demote to contradicted (excluded + never re-proposed)
 *   Optional: { "note": "reason" } recorded in dreamMeta.reviewNote for audit.
 *
 *   Edit-before-ratify fields (any combination, tentative rows only):
 *   { "content": "...", "importance": 7, "triggerPhrases": ["..."] }
 *
 * DELETE /api/memory/dream/proposals/{id}
 *   Hard-delete the proposal. Distinct from rejection: a rejected
 *   proposal is marked contradicted so Dream never re-proposes it; a
 *   deleted one is gone entirely (and MAY be re-proposed later).
 *
 * Returns 404 when the id isn't a tentative memory owned by the caller —
 * this prevents using this endpoint to probe for arbitrary memory ids
 * (the row exists but isn't tentative → 404 rather than 403 to avoid
 * leaking existence).
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import {
  deleteLongTermMemoryRow,
  getLongTermMemoryRow,
  ratifyLongTermMemory,
  updateTentativeMemoryRow,
} from '@/lib/core/db/memory/long-term';
import { getConfig } from '@/lib/core/kv/config';
import { reindexLongTermMemory } from '@/lib/memory/long-term';
import { invalidateProfileCache } from '@/lib/memory/profile';
import { invalidateRecallCache } from '@/lib/memory/recall';
import { invalidateTriggerCache } from '@/lib/memory/triggers';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.memory.dream.proposals.id');

export const dynamic = 'force-dynamic';

async function requireAccess() {
  const cookieStore = await cookies();
  return requireAuthAccess(cookieStore);
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }
  throw error;
}

/** Drop every memory-derived cache for a user after a dream write. */
async function invalidateMemoryCaches(userId: string) {
  invalidateRecallCache(userId);
  invalidateTriggerCache(userId);
  await invalidateProfileCache(userId);
}

/**
 * Fire-and-forget reindex: dream-written rows go through the DAL and
 * skip chunk indexing, so a ratified/edited row must be (re)indexed to
 * become searchable.
 */
async function scheduleReindex(memoryId: string) {
  const config = await getConfig().catch(() => null);
  reindexLongTermMemory({ memoryId, config: config ?? undefined }).catch(
    (error) => {
      logger.warn('proposal:reindex_failed', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAccess();
  } catch (error) {
    return authErrorResponse(error);
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const hasRatified = typeof body?.ratified === 'boolean';
  const hasContent =
    typeof body?.content === 'string' && body.content.trim().length > 0;
  const hasImportance = typeof body?.importance === 'number';
  const hasTriggerPhrases = Array.isArray(body?.triggerPhrases);

  if (!hasRatified && !hasContent && !hasImportance && !hasTriggerPhrases) {
    return NextResponse.json(
      {
        error:
          'body must include boolean "ratified" and/or editable fields (content, importance, triggerPhrases)',
      },
      { status: 400 },
    );
  }

  // Edit-before-ratify: applied first so a combined { content, ratified:
  // true } call reviews the EDITED text. Restricted to tentative rows by
  // the DAL.
  if (hasContent || hasImportance || hasTriggerPhrases) {
    const edited = await updateTentativeMemoryRow({
      id,
      userId: access.user.id,
      ...(hasContent ? { content: body.content } : {}),
      ...(hasImportance ? { importance: body.importance } : {}),
      ...(hasTriggerPhrases
        ? {
            triggerPhrases: (body.triggerPhrases as unknown[])
              .filter((phrase): phrase is string => typeof phrase === 'string')
              .map((phrase) => phrase.trim())
              .filter((phrase) => phrase.length >= 2)
              .slice(0, 5),
          }
        : {}),
    });
    if (!edited) {
      return NextResponse.json(
        { error: 'proposal not found' },
        { status: 404 },
      );
    }
    if (hasContent) {
      await scheduleReindex(id);
    }
  }

  let updated: Awaited<ReturnType<typeof ratifyLongTermMemory>> | null = null;
  if (hasRatified) {
    const note =
      typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;

    updated = await ratifyLongTermMemory({
      id,
      userId: access.user.id,
      ratified: body.ratified,
      note,
    });

    if (!updated) {
      // Either the id doesn't exist, isn't owned by this user, or isn't
      // currently tentative. Return 404 uniformly to avoid leaking existence.
      return NextResponse.json(
        { error: 'proposal not found' },
        { status: 404 },
      );
    }

    if (body.ratified) {
      await scheduleReindex(id);
    }

    logger.info('proposal:ratified', {
      userId: access.user.id,
      memoryId: id,
      ratified: body.ratified,
    });
  }

  // Caches that depend on the active set must be dropped so the next
  // prompt build sees the review immediately.
  await invalidateMemoryCaches(access.user.id);

  return NextResponse.json({
    id,
    ...(updated
      ? { dreamStatus: updated.dreamStatus, dreamMeta: updated.dreamMeta }
      : { edited: true }),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAccess();
  } catch (error) {
    return authErrorResponse(error);
  }

  const { id } = await params;

  // Guard: only tentative rows may be deleted through this path — an
  // active memory must go through the main memory deletion flow, which
  // has its own ownership checks.
  const row = await getLongTermMemoryRow(id, { userId: access.user.id });
  if (row?.dreamStatus !== 'tentative') {
    return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  }

  const deleted = await deleteLongTermMemoryRow(id, {
    userId: access.user.id,
  });
  if (!deleted) {
    return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  }

  await invalidateMemoryCaches(access.user.id);

  logger.info('proposal:deleted', {
    userId: access.user.id,
    memoryId: id,
  });

  return NextResponse.json({ id, deleted: true });
}
