import { and, eq, sql } from 'drizzle-orm';
import { db } from './index';
import { nodeUsageDaily, taskUsage } from './schema';

/**
 * Token usage DAL.
 *
 * Two scales:
 *   - per-task (taskUsage): written when a task step reports usage; the
 *     UNIQUE (taskId, provider, model) index makes upserts add rather
 *     than duplicate.
 *   - per-node-per-day (nodeUsageDaily): rollup for spend dashboards;
 *     UNIQUE (nodeId, date, provider, model) makes the increment
 *     idempotent across same-day same-key reports.
 *
 * `costUsdTicks` is provider-reported authoritative cost in 1e-10 USD
 * ticks; NULL means "no authoritative figure, estimate from rate table".
 */

export interface UsageRecordInput {
  taskId: string;
  userId?: string | null;
  nodeId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsdTicks?: number | null;
  meta?: Record<string, unknown> | null;
}

function todayDateString(now: Date = new Date()): string {
  // YYYY-MM-DD in the server's local timezone is fine for daily rollups;
  // Drizzle `date` mode round-trips this. Use ISO date part.
  return now.toISOString().slice(0, 10);
}

/**
 * Record per-task usage with an additive upsert. Re-reporting the same
 * (taskId, provider, model) adds to the existing row rather than
 * overwriting — callers that want overwrite semantics must read-then-
 * diff before calling. The matching per-node-per-day rollup is updated
 * in the same call so daily dashboards stay in sync.
 */
export async function recordTaskUsage(input: UsageRecordInput): Promise<void> {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;

  // Per-task additive upsert.
  await db
    .insert(taskUsage)
    .values({
      taskId: input.taskId,
      userId: input.userId ?? null,
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsdTicks: input.costUsdTicks ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: [taskUsage.taskId, taskUsage.provider, taskUsage.model],
      set: {
        inputTokens: sql`${taskUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${taskUsage.outputTokens} + ${outputTokens}`,
        cacheReadTokens: sql`${taskUsage.cacheReadTokens} + ${cacheReadTokens}`,
        cacheWriteTokens: sql`${taskUsage.cacheWriteTokens} + ${cacheWriteTokens}`,
        ...(input.costUsdTicks != null
          ? {
              costUsdTicks: sql`${taskUsage.costUsdTicks} + ${input.costUsdTicks}`,
            }
          : {}),
        updatedAt: new Date(),
      },
    });

  // Per-node-per-day rollup (if a node is named).
  if (input.nodeId) {
    const date = todayDateString();
    await db
      .insert(nodeUsageDaily)
      .values({
        nodeId: input.nodeId,
        userId: input.userId ?? null,
        date,
        provider: input.provider,
        model: input.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsdTicks: input.costUsdTicks ?? null,
      })
      .onConflictDoUpdate({
        target: [
          nodeUsageDaily.nodeId,
          nodeUsageDaily.date,
          nodeUsageDaily.provider,
          nodeUsageDaily.model,
        ],
        set: {
          inputTokens: sql`${nodeUsageDaily.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${nodeUsageDaily.outputTokens} + ${outputTokens}`,
          cacheReadTokens: sql`${nodeUsageDaily.cacheReadTokens} + ${cacheReadTokens}`,
          cacheWriteTokens: sql`${nodeUsageDaily.cacheWriteTokens} + ${cacheWriteTokens}`,
          ...(input.costUsdTicks != null
            ? {
                costUsdTicks: sql`${nodeUsageDaily.costUsdTicks} + ${input.costUsdTicks}`,
              }
            : {}),
          updatedAt: new Date(),
        },
      });
  }
}

export interface UsageSum {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdTicks: number | null;
}

function emptySum(): UsageSum {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdTicks: null,
  };
}

/**
 * Pure reducer: sum an array of partial-Usage rows into one UsageSum.
 * Exported for unit testing; production callers pass DB rows.
 */
export function sumUsageRows<
  T extends {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsdTicks: number | null;
  },
>(rows: T[]): UsageSum {
  return rows.reduce((acc, r) => {
    acc.inputTokens += r.inputTokens ?? 0;
    acc.outputTokens += r.outputTokens ?? 0;
    acc.cacheReadTokens += r.cacheReadTokens ?? 0;
    acc.cacheWriteTokens += r.cacheWriteTokens ?? 0;
    if (r.costUsdTicks != null) {
      acc.costUsdTicks = (acc.costUsdTicks ?? 0) + r.costUsdTicks;
    }
    return acc;
  }, emptySum());
}

/** Sum usage across all rows for a task. */
export async function getTaskUsageSum(taskId: string): Promise<UsageSum> {
  const rows = await db
    .select()
    .from(taskUsage)
    .where(eq(taskUsage.taskId, taskId));
  return sumUsageRows(rows);
}

/** Sum usage for a user over an optional date range (for spend dashboards). */
export async function getUserUsageSum(input: {
  userId: string;
  fromDate?: string; // YYYY-MM-DD inclusive
  toDate?: string; // YYYY-MM-DD inclusive
}): Promise<UsageSum> {
  const conditions = [eq(nodeUsageDaily.userId, input.userId)];
  if (input.fromDate) {
    conditions.push(sql`${nodeUsageDaily.date} >= ${input.fromDate}`);
  }
  if (input.toDate) {
    conditions.push(sql`${nodeUsageDaily.date} <= ${input.toDate}`);
  }
  const rows = await db
    .select()
    .from(nodeUsageDaily)
    .where(and(...conditions));
  return sumUsageRows(rows);
}

/** Delete all usage rows for a task (cleanup hook on task deletion). */
export async function deleteTaskUsage(taskId: string): Promise<void> {
  await db.delete(taskUsage).where(eq(taskUsage.taskId, taskId));
}
