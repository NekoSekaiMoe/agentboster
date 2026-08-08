import { and, eq, sql } from 'drizzle-orm';
import { db, resolveDriver } from './index';
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
 * diff before calling.
 *
 * Atomicity caveat: the neon-http driver (Vercel) does NOT support
 * `db.transaction()` — it throws at runtime. On that driver we fall back
 * to two sequential writes (per-task then per-node-per-day), accepting
 * a small desync window if the second write fails. On node-postgres
 * (self-hosted) both writes run in a real transaction. The COALESCE
 * null-propagation guard applies in both paths.
 */
export async function recordTaskUsage(input: UsageRecordInput): Promise<void> {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;

  // Per-task additive upsert, then the per-node-per-day rollup. Wrap in
  // a transaction when the driver supports it (node-postgres / self-hosted).
  // neon-http (Vercel) has no transaction support — there we run the two
  // writes sequentially and accept the small desync window.
  const runInTransaction =
    resolveDriver(process.env.DATABASE_URL ?? '') !== 'neon';
  // Both NeonHttpDatabase and pg's PgTransaction expose `.insert(...)` with
  // the same shape for our purposes, but their concrete TS types are not
  // mutually assignable. Narrow to the minimal surface we use so a single
  // helper body type-checks against both drivers.
  type Inserter = Pick<typeof db, 'insert'>;
  const asInserter = (client: unknown): Inserter => client as Inserter;
  const writeBoth = async (tx: Inserter) => {
    await tx
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
          inputTokens: sql`coalesce(${taskUsage.inputTokens}, 0) + ${inputTokens}`,
          outputTokens: sql`coalesce(${taskUsage.outputTokens}, 0) + ${outputTokens}`,
          cacheReadTokens: sql`coalesce(${taskUsage.cacheReadTokens}, 0) + ${cacheReadTokens}`,
          cacheWriteTokens: sql`coalesce(${taskUsage.cacheWriteTokens}, 0) + ${cacheWriteTokens}`,
          ...(input.costUsdTicks != null
            ? {
                costUsdTicks: sql`coalesce(${taskUsage.costUsdTicks}, 0) + ${input.costUsdTicks}`,
              }
            : {}),
          updatedAt: new Date(),
        },
      });

    // Per-node-per-day rollup (if a node is named).
    if (input.nodeId) {
      const date = todayDateString();
      await tx
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
            inputTokens: sql`coalesce(${nodeUsageDaily.inputTokens}, 0) + ${inputTokens}`,
            outputTokens: sql`coalesce(${nodeUsageDaily.outputTokens}, 0) + ${outputTokens}`,
            cacheReadTokens: sql`coalesce(${nodeUsageDaily.cacheReadTokens}, 0) + ${cacheReadTokens}`,
            cacheWriteTokens: sql`coalesce(${nodeUsageDaily.cacheWriteTokens}, 0) + ${cacheWriteTokens}`,
            ...(input.costUsdTicks != null
              ? {
                  costUsdTicks: sql`coalesce(${nodeUsageDaily.costUsdTicks}, 0) + ${input.costUsdTicks}`,
                }
              : {}),
            updatedAt: new Date(),
          },
        });
    }
  };

  if (runInTransaction) {
    await db.transaction(writeBoth as Parameters<typeof db.transaction>[0]);
  } else {
    await writeBoth(asInserter(db));
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
