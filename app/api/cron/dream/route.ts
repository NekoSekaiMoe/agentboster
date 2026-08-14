/**
 * Nightly Dream consolidation trigger.
 *
 * Invoked by an external scheduler (Vercel Cron, systemd timer, or any
 * HTTP-aware cron) carrying `CRON_SECRET`. Fans out to one Dream run per
 * user that has long-term memories.
 *
 * Why external cron (not an in-process scheduler):
 *  - Vercel runs Next.js as serverless functions; a long-lived in-process
 *    scheduler cannot survive between invocations. An external HTTP cron
 *    works identically on Vercel AND self-hosted (same dual-deployment
 *    principle as the rest of the project).
 *
 * Suggested schedule (Vercel Cron syntax in vercel.json):
 *   { "path": "/api/cron/dream", "schedule": "0 3 * * *" }
 * (03:00 UTC daily; per-user work is idempotent so overlap is safe.)
 *
 * Auth: `CRON_SECRET` env var, verified constant-time via
 * `checkCronSecret`. Returns 503 when CRON_SECRET is unset so
 * misconfiguration fails closed.
 */

import { NextResponse } from 'next/server';

import { listDistinctLongTermMemoryUserIds } from '@/lib/core/db/memory/long-term';
import { runDreamForUser } from '@/lib/memory/dream';
import { createLogger } from '@/lib/utils/logger';
import { checkCronSecret } from '@/lib/security/cron-auth';

export const dynamic = 'force-dynamic';
// Dream runs may exceed Vercel's default function timeout; opt into the
// longer cron budget. Self-hosted ignores this hint.
export const maxDuration = 300;

const logger = createLogger('api.cron.dream');

export async function POST(request: Request): Promise<Response> {
  const auth = checkCronSecret(request);
  if (!auth.valid) {
    // Distinguish "CRON_SECRET not configured" (503, fail-closed) from
    // "wrong/missing secret" (401). Collapsing both to 401 would hide
    // misconfiguration as an auth error.
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

  // Optional single-user override — when the body carries { "userId": "..." }
  // only that user is processed. Useful for manual re-runs / debugging.
  // Empty/invalid body → fan out to all users with memories.
  let singleUserId: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.userId === 'string' && body.userId.trim()) {
      singleUserId = body.userId.trim();
    }
  } catch {
    // No body or non-JSON — that's fine, fan out to all users.
  }

  const userIds = singleUserId
    ? [singleUserId]
    : await listDistinctLongTermMemoryUserIds();
  if (userIds.length === 0) {
    return NextResponse.json({
      ok: true,
      message: 'no users with memories',
      runs: [],
    });
  }

  logger.info('cron:dream_start', { userCount: userIds.length });

  // Sequential rather than parallel: each Dream run fans out multiple LLM
  // consolidation calls (one per concept group). Running them in parallel
  // would multiply LLM concurrency by the user count and risk provider
  // rate limits. Sequential keeps the concurrency footprint bounded by a
  // single user's group count.
  const runs = [];
  const failures = [];
  for (const userId of userIds) {
    try {
      const outcome = await runDreamForUser({ userId });
      runs.push({
        userId,
        runId: outcome.runId,
        phases: outcome.phases,
        consolidated: outcome.consolidated,
        rejectedDuplicates: outcome.rejectedDuplicates,
        applied: outcome.applied,
        failed: outcome.failed,
      });
    } catch (error) {
      failures.push({
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('cron:dream_user_failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('cron:dream_done', {
    userCount: userIds.length,
    succeeded: runs.length,
    failed: failures.length,
  });

  return NextResponse.json({
    ok: failures.length === 0,
    succeeded: runs.length,
    failed: failures.length,
    runs,
    failures,
  });
}

/**
 * GET is the verb Vercel Cron uses by default. Same handler as POST so
 * either trigger style works without operator config.
 */
export const GET = POST;
