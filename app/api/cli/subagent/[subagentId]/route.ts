/**
 * GET /api/cli/subagent/:subagentId
 *
 * Returns info about a specific subagent (task, status, summary).
 * Proxied to agentd GET /api/v1/subagents/:id.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import { proxyGetToAgentd } from '@/lib/extra/agent/agentd-proxy';

function getSubagentIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/subagent\/([^/]+)$/);
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

  const result = await proxyGetToAgentd(`/api/v1/subagents/${subagentId}`);
  return Response.json(
    { ok: result.ok, data: result.data },
    { status: result.status },
  );
});
