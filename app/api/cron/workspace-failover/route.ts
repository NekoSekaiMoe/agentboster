/**
 * Workspace failover cron.
 *
 * Invoked by an external scheduler (Vercel Cron, systemd timer) carrying
 * `CRON_SECRET`. Mirrors the piggybacked sweep in the heartbeat route for
 * deployments where the heartbeat path doesn't run regularly — primarily
 * Vercel serverless, where there's no long-lived process AND heartbeats
 * only arrive while at least one agentd node is alive.
 *
 * Calls {@link failoverOfflineWorkspaces} directly (no self-hosted gate, no
 * in-process throttle) because cron is already globally rate-limited by
 * schedule.
 *
 * Suggested schedule (add to vercel.json cron):
 *   { "path": "/api/cron/workspace-failover", "schedule": "0,10,20,30,40,50 * * * *" }
 * (every 10 minutes; FAILOVER_GRACE_MS is 5m so this gives a 5-15m effective
 * failover latency, which matches the heartbeat path's behavior.)
 *
 * Auth: `CRON_SECRET` env var, verified constant-time via `checkCronSecret`.
 * Returns 503 when CRON_SECRET is unset (fail-closed).
 */

import { NextResponse } from 'next/server';
import { failoverOfflineWorkspaces } from '@/lib/extra/agent/workspace-failover';
import { createLogger } from '@/lib/utils/logger';
import { checkCronSecret } from '@/lib/security/cron-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('api.cron.workspace-failover');

export async function POST(request: Request): Promise<Response> {
  const auth = checkCronSecret(request);
  if (!auth.valid) {
    return NextResponse.json(
      {
        error:
          auth.reason === 'unconfigured'
            ? 'CRON_SECRET not configured'
            : 'Unauthorized',
      },
      { status: auth.reason === 'unconfigured' ? 503 : 401 },
    );
  }

  try {
    const failedOver = await failoverOfflineWorkspaces();
    if (failedOver > 0) {
      logger.info('workspaces failed over (offline node)', {
        count: failedOver,
      });
    }
    return NextResponse.json({ success: true, failedOver });
  } catch (error) {
    logger.error('workspace failover cron failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Failover sweep failed' },
      { status: 500 },
    );
  }
}

// Vercel Cron issues GET requests (not POST). Reuse the POST handler so the
// documented cron config in the header comment actually works — without
// this, Vercel Cron receives a 405 and the failover sweep never runs.
// POST is kept for systemd timer callers that POST explicitly.
export async function GET(request: Request): Promise<Response> {
  return POST(request);
}
