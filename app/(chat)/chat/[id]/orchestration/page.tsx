import { OrchestrationGraph } from '@/components/orchestration/orchestration-graph';
import { PlanEditor } from '@/components/orchestration/plan-editor';
import { canAccessOwnedResource, requireAuthAccess } from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import { listPlansBySession } from '@/lib/core/db/agent-orchestration-plans';
import { getConfig } from '@/lib/core/kv/config';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /chat/[id]/orchestration
 *
 * Team Mode hub: left pane is the read-only React Flow graph (stage 1) of
 * live subagent batches / barriers / handoffs; right pane is the manual
 * plan editor (stage 2) where the user can author a fan-out plan and submit
 * it as a chat instruction.
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
  if (!session) {
    redirect(`/chat/${sessionId}`);
  }
  if (!canAccessOwnedResource(access, session.userId)) notFound();
  if (access.session.userId !== session.userId) {
    redirect(`/chat/${sessionId}`);
  }

  const [plans, config] = await Promise.all([
    listPlansBySession(sessionId),
    getConfig(),
  ]);
  const agentNames = Object.keys(config.agents ?? {});
  const agents =
    agentNames.length > 0
      ? agentNames.map((name) => ({ name }))
      : [{ name: 'default' }];

  return (
    <div className="mx-auto flex h-screen max-w-7xl flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Link
          href={`/chat/${sessionId}`}
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回会话
        </Link>
        <h1 className="font-semibold text-lg">编排</h1>
        <span className="text-muted-foreground text-xs">
          左：实时多智能体活动 · 右：手动规划
        </span>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col overflow-hidden">
          <OrchestrationGraph sessionId={sessionId} />
        </div>
        <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <PlanEditor
            sessionId={sessionId}
            plans={plans as never}
            agents={agents.length > 0 ? agents : [{ name: 'default' }]}
          />
        </div>
      </div>
    </div>
  );
}
