import { requireAuthAccess } from '@/lib/auth/access';
import { db, schema } from '@/lib/core/db';
import { and, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

type FrontendStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'aborted';

function mapStatus(session: {
  status: string;
  workflowRunId: string | null;
  metadata: Record<string, unknown> | null;
}): FrontendStatus {
  if (session.status === 'completed') return 'completed';
  if (session.status === 'stopped') return 'aborted';

  if (session.status === 'active' && session.workflowRunId) {
    const metadata = session.metadata;
    const latestApproval = metadata?.latestApproval as
      | { status?: string }
      | undefined;
    if (latestApproval?.status === 'pending') return 'waiting_user';
    return 'running';
  }

  return 'idle';
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const conditions = [eq(schema.sessions.archived, false)];
    if (!access.isAdmin) {
      conditions.push(eq(schema.sessions.userId, access.session.userId));
    }

    const sessions = await db
      .select({
        session_id: schema.sessions.id,
        status: schema.sessions.status,
        workflowRunId: schema.sessions.workflowRunId,
        metadata: schema.sessions.metadata,
      })
      .from(schema.sessions)
      .where(and(...conditions))
      .limit(100);

    const data = sessions.map((s) => ({
      session_id: s.session_id,
      status: mapStatus({
        status: s.status,
        workflowRunId: s.workflowRunId,
        metadata: s.metadata,
      }),
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Failed to fetch session status:', error);
    return NextResponse.json({ data: [] });
  }
}
