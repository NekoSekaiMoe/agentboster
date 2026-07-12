/**
 * GET /api/cli/subagent-batch/:batchId
 *
 * Returns the status of a subagent batch (all jobs + aggregate counts).
 * Proxied to agentd GET /api/v1/subagent-batches/:batchId.
 * Falls back to DB query if agentd is unreachable.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import { proxyGetToAgentd } from '@/lib/extra/agent/agentd-proxy';
import { db, schema } from '@/lib/core/db';
import { eq } from 'drizzle-orm';

function getBatchIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/subagent-batch\/([^/]+)$/);
  return match?.[1] ?? null;
}

export const GET = withCliAuth(async (request) => {
  const batchId = getBatchIdFromUrl(request);
  if (!batchId) {
    return Response.json(
      { ok: false, error: 'batchId is required' },
      { status: 400 },
    );
  }

  const result = await proxyGetToAgentd(`/api/v1/subagent-batches/${batchId}`);

  if (result.ok) {
    return Response.json({ ok: true, data: result.data }, { status: 200 });
  }

  // Fallback: query the DB if agentd is unreachable
  try {
    const batchRows = await db
      .select()
      .from(schema.agentSubagentBatches)
      .where(eq(schema.agentSubagentBatches.batchId, batchId))
      .limit(1);

    if (batchRows.length === 0) {
      return Response.json(
        { ok: false, error: 'batch not found' },
        { status: 404 },
      );
    }

    const batch = batchRows[0];
    const jobs = await db
      .select()
      .from(schema.agentSubagentJobs)
      .where(eq(schema.agentSubagentJobs.batchStableId, batchId));

    return Response.json({
      ok: true,
      data: {
        batch_id: batch.batchId,
        status: batch.status,
        concurrency_limit: batch.concurrencyLimit,
        succeeded: batch.succeeded,
        failed: batch.failed,
        cancelled: batch.cancelled,
        jobs: jobs.map((j) => ({
          subagent_id: j.subagentId,
          agent_name: j.agentName,
          task: j.task,
          status: j.status,
          summary: j.summary,
          error: j.error,
          steps: j.steps,
        })),
      },
    });
  } catch (dbErr) {
    return Response.json(
      {
        ok: false,
        error: `agentd unreachable and DB fallback failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      },
      { status: 502 },
    );
  }
});
