export const dynamic = 'force-dynamic';

import { getRun } from 'workflow/api';
import { getSession, updateSession } from '@/lib/core/db/chat';
import { abortAgentdSession } from '@/lib/extra/agent/agentd-tools-client';

async function cancelWorkflow(runId: string | null) {
  if (!runId) {
    return false;
  }

  try {
    await getRun(runId).cancel();
    return true;
  } catch {
    return false;
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession(id);

  if (!session) {
    return Response.json(
      { success: false, error: 'Session not found' },
      { status: 404 },
    );
  }

  const [daemonAborted, workflowCancelled] = await Promise.all([
    abortAgentdSession(id),
    cancelWorkflow(session.workflowRunId),
  ]);

  await updateSession(id, {
    workflowRunId: null,
    status: 'stopped',
    metadata: {
      ...(session.metadata ?? {}),
      stoppedAt: new Date().toISOString(),
      daemonAborted,
      workflowCancelled,
    },
  });

  return Response.json({
    success: true,
    data: {
      daemonAborted,
      workflowCancelled,
    },
  });
}
