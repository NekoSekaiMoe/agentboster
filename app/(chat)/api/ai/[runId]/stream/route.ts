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

  // Explicit startIndex: 0 — replay EVERY chunk from the beginning of
  // the run, not just new ones. This is the default behavior of
  // getReadable() (verified against @workflow/world-local's streamer:
  // getStreamChunks uses startIndex=0 when no cursor is provided), but
  // we set it explicitly so the fire-and-forget contract is self-
  // documenting: POST /api/ai returns 202 immediately, and this GET
  // must hand the client the full chunk history (including anything
  // produced between the 202 and this reconnect). Without this, a
  // server-side default change could silently break the UX.
  return createUIMessageStreamResponse({
    stream: guardWorkflowChunks(
      getWorkflowRun(runId).getReadable({ startIndex: 0 }),
    ),
    headers: {
      'x-session-id': session.id,
      'x-workflow-run-id': runId,
    },
  });
}
