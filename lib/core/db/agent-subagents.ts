/**
 * DB layer for the agent_subagent_batches + agent_subagent_jobs tables.
 *
 * Phase C-full of the multi-agent collaboration design. Replaces the
 * jsonb-blob persistence in sessions.metadata.workflowSubagents.
 *
 * Concurrency contract:
 *   - createBatch inserts the batch row and its jobs in a single call
 *     (two INSERTs; jobs reference the batch by stable_id so no FK
 *     timing issue).
 *   - updateJobStatus is the ONLY writer that flips a job's status
 *     from non-terminal to terminal (completed/failed/cancelled). It
 *     bumps the parent batch's succeeded/failed/cancelled counters in
 *     the same call and re-evaluates the batch status.
 *
 * Legacy migration:
 *   If a query can't find a batch in these tables, callers may pass
 *   the legacy metadata blob via `migrateFromLegacyMetadata()` which
 *   upserts the batch + jobs. The subAgent tool does this lazily on
 *   read so existing in-flight batches survive the deploy.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import {
  agentSubagentBatches,
  agentSubagentJobs,
  type AgentSubagentBatch,
  type AgentSubagentJob,
} from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('db.agent-subagents');

export type SubagentBatchStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type SubagentJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CreateBatchInput {
  batchId: string;
  sessionId?: string;
  runId?: string;
  barrierId?: string;
  concurrencyLimit: number;
  jobs: Array<{
    subagentId: string;
    agentName: string;
    task: string;
  }>;
}

export interface UpdateJobStatusInput {
  subagentId: string;
  status: SubagentJobStatus;
  modelId?: string;
  steps?: number;
  summary?: string;
  error?: string;
}

export interface BatchWithJobs {
  batch: AgentSubagentBatch;
  jobs: AgentSubagentJob[];
}

/** Create a batch with all its queued jobs. Atomic from the caller's
 *  perspective: if any INSERT fails, the caller can retry the whole
 *  createBatch. The batchId and subagentId uniqueness constraints make
 *  retries idempotent (the retry will fail on the unique index, which
 *  the caller detects and treats as "already created"). */
export async function createBatch(
  input: CreateBatchInput,
): Promise<AgentSubagentBatch> {
  const [batch] = await db
    .insert(agentSubagentBatches)
    .values({
      batchId: input.batchId,
      sessionId: input.sessionId,
      runId: input.runId,
      barrierId: input.barrierId,
      concurrencyLimit: input.concurrencyLimit,
      status: 'running',
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    })
    .returning();

  if (input.jobs.length > 0) {
    await db.insert(agentSubagentJobs).values(
      input.jobs.map((j) => ({
        subagentId: j.subagentId,
        batchStableId: input.batchId,
        sessionId: input.sessionId,
        agentName: j.agentName,
        task: j.task,
        status: 'queued' as const,
      })),
    );
  }

  return batch;
}

/** Get a batch row by its stable id. */
export async function getBatch(
  batchStableId: string,
): Promise<AgentSubagentBatch | null> {
  const [row] = await db
    .select()
    .from(agentSubagentBatches)
    .where(eq(agentSubagentBatches.batchId, batchStableId))
    .limit(1);
  return row ?? null;
}

/** Get a batch with all its jobs, oldest-first. */
export async function getBatchWithJobs(
  batchStableId: string,
): Promise<BatchWithJobs | null> {
  const batch = await getBatch(batchStableId);
  if (!batch) return null;
  const jobs = await db
    .select()
    .from(agentSubagentJobs)
    .where(eq(agentSubagentJobs.batchStableId, batchStableId))
    .orderBy(asc(agentSubagentJobs.createdAt));
  return { batch, jobs };
}

/** List all batches for a session. */
export async function listBatchesBySession(
  sessionId: string,
): Promise<AgentSubagentBatch[]> {
  return db
    .select()
    .from(agentSubagentBatches)
    .where(eq(agentSubagentBatches.sessionId, sessionId))
    .orderBy(asc(agentSubagentBatches.createdAt));
}

/**
 * Flip a job to terminal (or running, for the start transition) and,
 * when entering a terminal state, bump the parent batch's counters
 * and re-evaluate its status.
 *
 * The job-update + counter-bump + batch-status-flip are NOT wrapped
 * in a transaction (drizzle's per-statement API doesn't make this
 * ergonomic); instead we rely on the invariant that only ONE caller
 * ever flips a given job to terminal (the worker that owns the job).
 * Counter drift is therefore impossible in normal operation; in the
 * worst case (process crash between updates), a batch may show
 * succeeded=N-1 with all jobs terminal — the caller can recompute by
 * counting jobs, which `recomputeBatchCounters` does.
 */
export async function updateJobStatus(
  input: UpdateJobStatusInput,
): Promise<{ job: AgentSubagentJob | null; batch: AgentSubagentBatch | null }> {
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: input.status,
    updatedAt: now,
  };
  if (input.modelId !== undefined) patch.modelId = input.modelId;
  if (input.steps !== undefined) patch.steps = input.steps;
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.error !== undefined) patch.error = input.error;
  if (input.status === 'running') patch.startedAt = now;
  if (
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'cancelled'
  ) {
    patch.finishedAt = now;
  }

  // Update the job row. Filter by current status != terminal so a
  // double-update from a buggy caller is a no-op rather than a
  // counter-desync.
  const [job] = await db
    .update(agentSubagentJobs)
    .set(patch)
    .where(
      and(
        eq(agentSubagentJobs.subagentId, input.subagentId),
        // Only allow transitions INTO terminal from non-terminal. The
        // 'running' transition is allowed from 'queued' or 'running'.
        inArray(agentSubagentJobs.status, ['queued', 'running', input.status]),
      ),
    )
    .returning();

  if (!job) {
    // Either the job doesn't exist or it was already terminal.
    return { job: null, batch: null };
  }

  // If the job transitioned to terminal, bump the batch counters and
  // re-evaluate batch status. We compute the new status by counting
  // the jobs in the DB (avoids drift if prior updates failed).
  if (
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'cancelled'
  ) {
    return recomputeBatchCounters(job.batchStableId);
  }

  const batch = await getBatch(job.batchStableId);
  return { job, batch };
}

/**
 * Recompute a batch's succeeded/failed/cancelled counters and overall
 * status from the current job rows. Called after every job-terminal
 * transition; also safe to call any time as a self-heal.
 */
export async function recomputeBatchCounters(
  batchStableId: string,
): Promise<{ job: null; batch: AgentSubagentBatch | null }> {
  const jobs = await db
    .select()
    .from(agentSubagentJobs)
    .where(eq(agentSubagentJobs.batchStableId, batchStableId));
  if (jobs.length === 0) {
    return { job: null, batch: await getBatch(batchStableId) };
  }

  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let stillRunning = false;
  for (const j of jobs) {
    if (j.status === 'completed') succeeded += 1;
    else if (j.status === 'failed') failed += 1;
    else if (j.status === 'cancelled') cancelled += 1;
    else stillRunning = true;
  }

  const total = jobs.length;
  const status: SubagentBatchStatus = stillRunning
    ? 'running'
    : cancelled === total
      ? 'cancelled'
      : failed > 0
        ? 'failed'
        : 'completed';

  const [batch] = await db
    .update(agentSubagentBatches)
    .set({
      succeeded,
      failed,
      cancelled,
      status,
      updatedAt: new Date(),
    })
    .where(eq(agentSubagentBatches.batchId, batchStableId))
    .returning();

  return { job: null, batch };
}

/** Cancel every non-terminal job in a batch (used by the cancel action). */
export async function cancelBatchJobs(
  batchStableId: string,
  reason: string,
): Promise<{ batch: AgentSubagentBatch | null; cancelled: number }> {
  const jobs = await db
    .select()
    .from(agentSubagentJobs)
    .where(
      and(
        eq(agentSubagentJobs.batchStableId, batchStableId),
        inArray(agentSubagentJobs.status, ['queued', 'running']),
      ),
    );

  if (jobs.length === 0) {
    return { batch: await getBatch(batchStableId), cancelled: 0 };
  }

  const now = new Date();
  let cancelled = 0;
  for (const j of jobs) {
    const [updated] = await db
      .update(agentSubagentJobs)
      .set({
        status: 'cancelled',
        error: reason,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentSubagentJobs.subagentId, j.subagentId),
          inArray(agentSubagentJobs.status, ['queued', 'running']),
        ),
      )
      .returning();
    if (updated) cancelled += 1;
  }

  const { batch } = await recomputeBatchCounters(batchStableId);
  return { batch, cancelled };
}

/**
 * Lazy legacy migration: if a batch exists in
 * sessions.metadata.workflowSubagents but not in the new tables,
 * backfill it. Idempotent — if the batch already exists in the new
 * tables, no-op.
 *
 * Called by the subAgent tool on read (query/collect/cancel) so a
 * deployment of phase C-full picks up in-flight batches from the
 * previous deploy without a separate migration script.
 */
export async function migrateBatchFromLegacyMetadata(input: {
  sessionId: string;
  batchId: string;
  /** The legacy metadata blob (workflowSubagents.{batches,jobs}). */
  legacy: {
    batches: Record<string, unknown>;
    jobs: Record<string, unknown>;
  };
}): Promise<BatchWithJobs | null> {
  // Already migrated?
  const existing = await getBatchWithJobs(input.batchId);
  if (existing) return existing;

  const legacyBatch = input.legacy.batches[input.batchId] as
    | {
        batchId?: string;
        status?: string;
        createdAt?: string;
        concurrencyLimit?: number;
        jobs?: string[];
        succeeded?: number;
        failed?: number;
        cancelled?: number;
      }
    | undefined;
  if (!legacyBatch) return null;

  // Insert the batch row.
  await db
    .insert(agentSubagentBatches)
    .values({
      batchId: input.batchId,
      sessionId: input.sessionId,
      concurrencyLimit: legacyBatch.concurrencyLimit ?? 1,
      status: (legacyBatch.status as SubagentBatchStatus) ?? 'running',
      succeeded: legacyBatch.succeeded ?? 0,
      failed: legacyBatch.failed ?? 0,
      cancelled: legacyBatch.cancelled ?? 0,
    })
    .onConflictDoNothing({ target: agentSubagentBatches.batchId });

  // Insert job rows.
  const jobIds = (legacyBatch.jobs ?? []) as string[];
  for (const jid of jobIds) {
    const j = input.legacy.jobs[jid] as
      | {
          subagentId?: string;
          agentName?: string;
          task?: string;
          status?: string;
          modelId?: string;
          steps?: number;
          summary?: string;
          error?: string;
          startedAt?: string;
          finishedAt?: string;
        }
      | undefined;
    if (!j?.subagentId || !j.agentName || !j.task) continue;
    await db
      .insert(agentSubagentJobs)
      .values({
        subagentId: j.subagentId,
        batchStableId: input.batchId,
        sessionId: input.sessionId,
        agentName: j.agentName,
        task: j.task,
        status: (j.status as SubagentJobStatus) ?? 'queued',
        modelId: j.modelId,
        steps: j.steps,
        summary: j.summary,
        error: j.error,
        startedAt: j.startedAt ? new Date(j.startedAt) : null,
        finishedAt: j.finishedAt ? new Date(j.finishedAt) : null,
      })
      .onConflictDoNothing({ target: agentSubagentJobs.subagentId });
  }

  logger.info('migrated batch from legacy metadata', {
    sessionId: input.sessionId,
    batchId: input.batchId,
    jobCount: jobIds.length,
  });

  return getBatchWithJobs(input.batchId);
}
