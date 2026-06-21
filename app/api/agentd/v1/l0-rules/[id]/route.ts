/**
 * L0 rules endpoint (daemon → web).
 *
 * P1.1: agentd's clawless.Client.GetL0Rules GETs here for per-agent L0
 * rule sets. Previously this route didn't exist so the daemon's L0
 * engine always fell back to DefaultPresets keyed by "default".
 *
 * Returns rules from the agentL0Rules table for the requested agentId
 * (plus any global rules). The daemon picks them up via the L0 loader
 * poller (every 5 minutes) or on-demand.
 */

export const dynamic = 'force-dynamic';

import { getL0Rules } from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l0-rules');

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  try {
    // getL0Rules already merges agent-specific + 'global' rules
    // (see lib/core/db/agentd.ts:508).
    const rules = await getL0Rules(agentId);

    logger.info('l0-rules fetched', {
      agentId,
      count: rules.length,
    });

    // Map DB rows into the daemon's L0Rule JSON shape.
    const data = rules.map((r) => ({
      id: r.id,
      agent_id: r.agentId,
      pattern: r.pattern,
      type: r.type,
      action: r.action,
      scope: r.scope,
      enabled: r.enabled,
    }));

    return Response.json({ success: true, data });
  } catch (error) {
    logger.error('l0-rules fetch failed', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'L0 rules fetch failed' },
      { status: 500 },
    );
  }
}
