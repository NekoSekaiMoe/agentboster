/**
 * Scheduled-task-run reaper.
 *
 * Invoked by an external scheduler (Vercel Cron, systemd timer) carrying
 * `CRON_SECRET`. Flips `pending`/`running` scheduled_task_runs rows that
 * have been stuck longer than the stale threshold to `failed` with
 * `runtime_recovery`, unblocking their (taskId, plannedAt) slots for
 * future re-dispatch.
 *
 * Why this is a cron route and not inline in dispatch.ts: agentboster is
 * serverless — no long-lived process to sweep. A stuck run (crash between
 * claimScheduledRunSlot and the terminal markRun*) would hold its slot
 * forever without a periodic reaper. claimScheduledRunSlot reuses only
 * terminal rows, so the reaper is the only path that converts stuck
 * non-terminal rows into reclaimable terminal ones.
 *
 * Suggested schedule (add to vercel.json cron):
 *   { "path": "/api/cron/reap-runs", "schedule": "0,10,20,30,40,50 * * * *" }
 * (every 10 minutes; the stale threshold is 15m by default so this gives
 * a 5-25m effective reap latency, well inside any reasonable schedule
 * cadence.)
 *
 * Auth: `CRON_SECRET` env var, verified constant-time via `checkCronSecret`.
 * Returns 503 when CRON_SECRET is unset (fail-closed) so misconfiguration
 * is visible rather than silently leaving stuck runs un-reaped.
 */

import { NextResponse } from 'next/server';
import { reapStuckRuns } from '@/lib/core/db/scheduled-task-runs';
import { createLogger } from '@/lib/utils/logger';
import { checkCronSecret } from '@/lib/security/cron-auth';

export const dynamic = 'force-dynamic';
// Quick DB UPDATE; well under the default function timeout.
export const maxDuration = 60;

const logger = createLogger('api.cron.reap-runs');

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
    const reaped = await reapStuckRuns();
    if (reaped > 0) {
      logger.info('reaped stuck runs', { count: reaped });
    }
    return NextResponse.json({ success: true, reaped });
  } catch (error) {
    logger.error('reap failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Reap failed' },
      { status: 500 },
    );
  }
}
