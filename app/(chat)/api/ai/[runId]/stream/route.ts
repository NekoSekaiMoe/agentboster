import { guardWorkflowChunks } from '@/lib/chat/stream-guard';
import { getSessionByWorkflowRunId } from '@/lib/core/db/chat';
import { ACTIVE_RUN_STATUSES } from '@/lib/workflow/agent/config';
import {
  getWorkflowRun,
  getWorkflowStatus,
} from '@/lib/workflow/agent/dispatch';
import { createUIMessageStreamResponse } from 'ai';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const session = await getSessionByWorkflowRunId(runId);

  if (!session) {
    return new Response(null, { status: 204 });
  }

  const status = await getWorkflowStatus(runId);
  const isActive = status && ACTIVE_RUN_STATUSES.has(status);
  const isCompleted = status === 'completed';

  if (!isActive && !isCompleted) {
    return new Response(null, { status: 204 });
  }

  return createUIMessageStreamResponse({
    stream: guardWorkflowChunks(getWorkflowRun(runId).readable),
    headers: {
      'x-session-id': session.id,
      'x-workflow-run-id': runId,
    },
  });
}
