import { OrchestrationGraph } from '@/components/orchestration/orchestration-graph';
import { canAccessOwnedResource, requireAuthAccess } from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /chat/[id]/orchestration
 *
 * Read-only Team Mode I view: a React Flow graph of the session's subagent
 * batches / jobs / barriers / handoffs. Purely a visibility surface for the
 * multi-agent primitives that already exist in the backend; no write actions.
 */
export default async function OrchestrationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: sessionId } = await params;
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore);
  const session = await getSession(sessionId);
  if (!session) notFound();
  if (!canAccessOwnedResource(access, session.userId)) notFound();

  // Bounce read-only cross-channel viewers (they shouldn't see internal
  // orchestration state of someone else's session).
  if (access.session.userId !== session.userId) {
    redirect(`/chat/${sessionId}`);
  }

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Link
          href={`/chat/${sessionId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回会话
        </Link>
        <h1 className="text-lg font-semibold">编排图</h1>
        <span className="text-xs text-muted-foreground">
          只读视图 · 每 3 秒自动刷新
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <OrchestrationGraph sessionId={sessionId} />
      </div>
    </div>
  );
}
