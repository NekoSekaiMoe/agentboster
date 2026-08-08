import { getSessionByWorkflowRunId } from '@/lib/core/db/chat';
import { guardWorkflowChunks } from '@/lib/chat/stream-guard';
import { ACTIVE_RUN_STATUSES } from '@/lib/workflow/agent/config';
import {
  getWorkflowRun,
  getWorkflowStatus,
} from '@/lib/workflow/agent/dispatch';
import { createUIMessageStreamResponse } from 'ai';

// Reconnect endpoint: the client re-subscribes to a workflow run's
// readable stream after the original POST /api/ai connection was
// dropped (e.g. maxDuration truncation, network blip). The run may
// still be long-lived, so this route needs the same elevated ceiling
// as the originating route.
export const maxDuration = 300;

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
