import { and, eq, sql } from 'drizzle-orm';
import { atomicWriteMode } from './atomic';
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
 *     UNIQUE (nodeId, date, provider, model) keeps one aggregate row, but
 *     callers must deduplicate retries before applying the increment.
 *
 * `costUsdTicks` is provider-reported authoritative cost in 1e-10 USD
 * ticks; NULL means "no authoritative figure, estimate from rate table".
 */

/**
 * Sentinel user_id for usage rows that have no attributable owner (a
 * shared/anonymous node, a pre-multi-user row). We must NOT store NULL
 * here: `nodeUsageDaily`'s unique index includes `user_id`, and Postgres
 * treats NULL as distinct (NULL != NULL), so a NULL would bypass the
 * conflict target and let identical (node,date,provider,model) rows
 * multiply. The sentinel keeps shared usage in its own bucket that is
 * still conflict-safe AND excluded from per-user spend queries.
 */
export const SHARED_USER_SENTINEL = '__shared__';

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
 * The matching per-node-per-day rollup is written atomically with the
 * per-task row so daily dashboards stay in sync even if one write fails.
 * The two drivers behind the `db` singleton have NON-overlapping atomic
 * primitives — neon-http exposes `db.batch([...])`, node-postgres exposes
 * `db.transaction(callback)` — so we branch on `atomicWriteMode()`.
 * The COALESCE null-propagation guard applies in both paths.
 */
export async function recordTaskUsage(input: UsageRecordInput): Promise<void> {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;

  // The per-node rollup (nodeUsageDaily) coerces NULL userId to the
  // SHARED_USER_SENTINEL — see its schema comment for why a NULL would
  // bypass the unique index. taskUsage is additive on
  // (taskId, provider, model) and is read via getTaskUsageSum (not keyed
  // on userId), so it tolerates a NULL userId without a conflict hazard.
  const effectiveUserId = input.userId ?? SHARED_USER_SENTINEL;

  // Build the per-task upsert once. The values/set clauses are identical
  // regardless of which client executes them; the difference is whether
  // they run inside a transaction (pg) or a batch (neon).
  const buildTaskUpsert = (client: Inserter) =>
    client
      .insert(taskUsage)
      .values({
        taskId: input.taskId,
        userId: effectiveUserId,
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
        set: taskConflictSet(taskUsage, input, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        }),
      });

  // No node rollup — just the per-task write. No atomicity needed.
  const nodeId = input.nodeId;
  if (!nodeId) {
    await buildTaskUpsert(db);
    return;
  }

  // Per-task + per-node-per-day rollup, run atomically. The two drivers
  // require different shapes — see the atomicWriteMode helper.
  const date = todayDateString();
  const buildNodeRollup = (client: Inserter) =>
    client
      .insert(nodeUsageDaily)
      .values({
        nodeId,
        userId: effectiveUserId,
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
          nodeUsageDaily.userId,
          nodeUsageDaily.date,
          nodeUsageDaily.provider,
          nodeUsageDaily.model,
        ],
        set: taskConflictSet(nodeUsageDaily, input, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        }),
      });

  if (atomicWriteMode() === 'neon') {
    // neon-http: db.batch is the atomic primitive (single HTTP transaction).
    // db.transaction would throw 'No transactions support in neon-http driver'.
    await db.batch([buildTaskUpsert(db), buildNodeRollup(db)]);
  } else {
    // node-postgres: db.transaction is the atomic primitive.
    // db.batch is undefined on NodePgDatabase.
    await db.transaction(async (tx) => {
      await buildTaskUpsert(tx as Inserter as typeof db);
      await buildNodeRollup(tx as Inserter as typeof db);
    });
  }
}

/**
 * Minimal client surface the recordTaskUsage builders use. Both the
 * module-level `db` singleton and a `db.transaction`'s `tx` satisfy this —
 * narrowing avoids the cross-driver type incompatibility between the
 * concrete NeonHttpDatabase and PgTransaction.
 */
type Inserter = Pick<typeof db, 'insert'>;

/**
 * Build the additive-increment `onConflictDoUpdate` set for a usage row.
 * Shared between taskUsage and nodeUsageDaily so both paths stay in sync.
 */
function taskConflictSet(
  table: typeof taskUsage | typeof nodeUsageDaily,
  input: UsageRecordInput,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
) {
  return {
    inputTokens: sql`coalesce(${table.inputTokens}, 0) + ${tokens.inputTokens}`,
    outputTokens: sql`coalesce(${table.outputTokens}, 0) + ${tokens.outputTokens}`,
    cacheReadTokens: sql`coalesce(${table.cacheReadTokens}, 0) + ${tokens.cacheReadTokens}`,
    cacheWriteTokens: sql`coalesce(${table.cacheWriteTokens}, 0) + ${tokens.cacheWriteTokens}`,
    ...(input.costUsdTicks != null
      ? {
          costUsdTicks: sql`coalesce(${table.costUsdTicks}, 0) + ${input.costUsdTicks}`,
        }
      : {}),
    updatedAt: new Date(),
  };
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
