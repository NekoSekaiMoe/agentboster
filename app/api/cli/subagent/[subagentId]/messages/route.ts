/**
 * GET /api/cli/subagent/:subagentId/messages
 *
 * Returns the conversation messages of a specific subagent.
 * Proxied to agentd GET /api/v1/subagents/:id/messages.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import { proxyGetToAgentd } from '@/lib/extra/agent/agentd-proxy';

function getSubagentIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/subagent\/([^/]+)\/messages$/);
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

  const result = await proxyGetToAgentd(
    `/api/v1/subagents/${subagentId}/messages`,
  );
  return Response.json(
    { ok: result.ok, data: result.data },
    { status: result.status },
  );
});
