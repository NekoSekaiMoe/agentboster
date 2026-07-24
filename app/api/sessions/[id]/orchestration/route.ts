import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import {
  listBatchesBySession,
  getBatchWithJobs,
} from '@/lib/core/db/agent-subagents';
import { listOpenBarriers } from '@/lib/core/db/agent-barriers';
import { listHandoffsForSession } from '@/lib/core/db/agent-handoffs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET /api/sessions/[id]/orchestration
 *
 * Read-only snapshot of the multi-agent orchestration state for a session:
 * every subagent batch (+ its jobs), every open barrier, and every handoff
 * (in or out). Consumed by the React Flow orchestration graph in the Web UI
 * (Team Mode I). This is the "make the existing batch/barrier/handoff
 * primitives visible" half of the team-mode design — the data already lived
 * in Postgres, there was just no surface to see it.
 *
 * Auth: same per-session ownership check as the other /api/sessions/[id]/*
 * routes. Read-only, so no CSRF/write concerns.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  assertCanAccessOwnedResource(access, session.userId);

  const [batches, barriers, handoffs] = await Promise.all([
    listBatchesBySession(sessionId),
    listOpenBarriers({ sessionId }),
    listHandoffsForSession(sessionId),
  ]);

  // Hydrate each batch with its jobs in one go.
  const batchesWithJobs = await Promise.all(
    batches.map((b) =>
      getBatchWithJobs(b.batchId).then((withJobs) => withJobs ?? b),
    ),
  );

  return NextResponse.json({
    sessionId,
    batches: batchesWithJobs,
    barriers,
    handoffs,
  });
}
