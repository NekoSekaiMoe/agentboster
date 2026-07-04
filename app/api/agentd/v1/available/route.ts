export const dynamic = 'force-dynamic';

import { isAgentdAvailable } from '@/lib/workflow/agent/dispatch';

/**
 * GET /api/agentd/v1/available
 *
 * Reports whether any agentd node is currently online AND responds to
 * a health probe — i.e. the same verdict `execToolOnAgentd` would
 * rely on before dispatching. Drives the chat-header status pill and
 * any other UI that needs to know "can we route through agentd right
 * now".
 *
 * Distinct from `/api/agentd/v1/health`: that route reports the
 * single daemon reachable via AGENTD_URL / nodes[0] (a diagnostic
 * view consumed by the agentd-config Web Direct Connection card and
 * by agentd's own reverse connectivity check, which only inspects
 * the HTTP status code). `available` is the multi-node-aware
 * "is the dispatch path usable" answer.
 */
export async function GET() {
  const available = await isAgentdAvailable().catch(() => false);

  return Response.json({
    success: true,
    data: {
      available,
      timestamp: new Date().toISOString(),
    },
  });
}
