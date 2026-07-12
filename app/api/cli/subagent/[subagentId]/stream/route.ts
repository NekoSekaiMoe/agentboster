/**
 * GET /api/cli/subagent/:subagentId/stream
 *
 * SSE proxy — streams subagent messages from agentd in real time.
 * Falls back to polling if agentd doesn't support SSE yet.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import { proxyGetToAgentd } from '@/lib/extra/agent/agentd-proxy';

function getSubagentIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/subagent\/([^/]+)\/stream$/);
  return match?.[1] ?? null;
}

export const GET = withCliAuth(async (request) => {
  const subagentId = getSubagentIdFromUrl(request);
  if (!subagentId) {
    return Response.json(
      { ok: false, error: 'subagentId is required' },
      { status: 400 },
    );
  }

  // For now, poll the messages endpoint and return as a single SSE frame.
  // When agentd adds native SSE streaming on /api/v1/subagents/:id/stream,
  // this route will proxy that SSE connection directly.
  const result = await proxyGetToAgentd(
    `/api/v1/subagents/${subagentId}/messages`,
  );

  if (!result.ok) {
    return Response.json(
      { ok: false, data: result.data },
      { status: result.status },
    );
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(result.data)}\n\n`),
      );
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
