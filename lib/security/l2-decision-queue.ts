/**
 * L2 Decision Queue — durable, DB-backed.
 *
 * P0.2: Previously this queue was a process-local in-memory Map, which
 * meant every Vercel redeploy or serverless cold start wiped all
 * pending L2 authorizations and ask_question prompts. The queue now
 * mirrors every state change into the l2_decisions Postgres table
 * (lib/core/db/l2-decisions.ts) and rehydrates from it on startup.
 *
 * Concurrency model (unchanged from prior implementation):
 *   - Decisions from different tasks are serialized.
 *   - Same-task decisions can be concurrent up to MAX_CONCURRENT_PER_TASK.
 *   - `enqueue` may immediately promote to `sent` if a slot is free.
 *
 * All mutating methods are async (they round-trip to the DB). Read
 * methods (`listPending`, `getSent`, `get`) are synchronous and read
 * from the in-memory cache, which is kept consistent by the mutators.
 * On startup, call `await rehydrateFromDb()` once.
 */

import { z } from 'zod';
import {
  countByStatus,
  createDecision,
  type L2Decision,
  markExpired,
  resolveDecision as dbResolve,
} from '@/lib/core/db/l2-decisions';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('security.l2-queue');

export const DecisionStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  RESOLVED: 'resolved',
  EXPIRED: 'expired',
  TIMEOUT: 'timeout',
  DENIED: 'denied',
} as const;

export type DecisionStatus =
  (typeof DecisionStatus)[keyof typeof DecisionStatus];

export const DecisionType = {
  L2_AUTH: 'l2_auth',
  QUESTION: 'question',
  CONFLICT: 'conflict',
  BRANCH: 'branch',
} as const;

export type DecisionType = (typeof DecisionType)[keyof typeof DecisionType];

export const DecisionSchema = z.object({
  decisionId: z.string(),
  type: z.nativeEnum(DecisionType),
  taskId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  command: z.string().optional(),
  score: z.number().optional(),
  reason: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  prompts: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        options: z.array(z.string()).optional(),
        multiple: z.boolean().optional(),
      }),
    )
    .optional(),
  conflict: z
    .object({
      files: z
        .array(
          z.object({
            path: z.string(),
            versions: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  branch: z
    .object({
      title: z.string().optional(),
      plan_a: z.record(z.string(), z.unknown()).optional(),
      plan_b: z.record(z.string(), z.unknown()).optional(),
      allow_custom: z.boolean().optional(),
    })
    .optional(),
  status: z.nativeEnum(DecisionStatus),
  nodeId: z.string().optional(),
  createdAt: z.date(),
  timeoutAt: z.date(),
  resolvedAt: z.date().optional(),
  resolvedBy: z.string().optional(),
  action: z.string().optional(),
  answers: z.array(z.array(z.string())).optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const DEFAULT_TIMEOUT = 3 * 60 * 1000; // 3 minutes
export const MAX_CONCURRENT_PER_TASK = 3;

const ACTIVE: readonly DecisionStatus[] = [
  DecisionStatus.PENDING,
  DecisionStatus.SENT,
];

/**
 * DecisionQueue serializes requests awaiting user action.
 */
export class DecisionQueue {
  private decisions = new Map<string, Decision>();
  private pendingOrder: string[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  /** Resolvers for in-process waitForResolution() callers (Web TS agent
   *  ask_question tool). Daemon-side questions don't use this — they're
   *  fire-and-forget and the answer is forwarded via HTTP. */
  private resolvers = new Map<string, (decision: Decision | null) => void>();

  constructor(private timeoutMs: number = DEFAULT_TIMEOUT) {
    this.startTimeoutMonitor();
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Load active decisions from the DB into the in-memory cache.
   * Call once at boot before serving requests. Safe to call multiple
   * times — it clears and refills the cache.
   */
  async rehydrateFromDb(): Promise<void> {
    const { loadActiveDecisions } = await import('@/lib/core/db/l2-decisions');
    const rows = await loadActiveDecisions();
    this.decisions.clear();
    this.pendingOrder = [];
    for (const row of rows) {
      const decision = rowToDecision(row);
      this.decisions.set(decision.decisionId, decision);
      this.pendingOrder.push(decision.decisionId);
    }
    if (rows.length > 0) {
      logger.info('rehydrated decisions from db', { count: rows.length });
    }
  }

  /**
   * Add a decision to the queue without blocking.
   * Returns true if the decision was immediately promoted to "sent".
   *
   * Persists to the DB; the in-memory cache mirrors the same state.
   */
  async enqueue(decision: Decision): Promise<boolean> {
    this.initDecision(decision);

    // Persist first; if the DB write fails, we still record in-memory
    // so the current request can proceed, but the decision will not
    // survive a redeploy.
    try {
      await createDecision({
        decisionId: decision.decisionId,
        taskId: decision.taskId,
        sessionId: decision.sessionId,
        agentId: decision.agentId ?? '',
        type: decision.type,
        payload: decisionToPayload(decision),
        status: decision.status,
        nodeId: decision.nodeId,
        expiresAt: decision.timeoutAt,
      });
    } catch (err) {
      logger.error('db persist failed; continuing in-memory only', {
        decisionId: decision.decisionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.decisions.set(decision.decisionId, { ...decision });
    this.pendingOrder.push(decision.decisionId);

    if (this.canPromote(decision.taskId)) {
      this.promote(decision.decisionId);
      return true;
    }
    return false;
  }

  /**
   * Mark a decision resolved with the given action and optional reply.
   */
  async resolve(
    decisionId: string,
    action: string,
    resolvedBy: string,
    answers?: string[][],
  ): Promise<Decision | null> {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      // Fall through to DB (may have been persisted by a prior instance).
      logger.warn('resolve: decision not in cache', { decisionId });
    }

    const now = new Date();
    const resolution: Record<string, unknown> = { action };
    if (answers) resolution.answers = answers;

    let updated: L2Decision | null = null;
    try {
      updated = await dbResolve(decisionId, resolvedBy, resolution, 'resolved');
    } catch (err) {
      logger.error('db resolve failed', {
        decisionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (decision) {
      decision.status = DecisionStatus.RESOLVED;
      decision.resolvedAt = now;
      decision.resolvedBy = resolvedBy;
      decision.action = action;
      if (answers) decision.answers = answers;
    }

    // Notify any in-process waitForResolution() caller (Web TS agent
    // ask_question tool).
    const resolver = this.resolvers.get(decisionId);
    if (resolver) {
      this.resolvers.delete(decisionId);
      resolver(decision ?? null);
    }

    this.advanceQueue();
    return updated ? rowToDecision(updated) : (decision ?? null);
  }

  /**
   * Mark a decision denied (user clicked reject / ignore).
   */
  async deny(decisionId: string, resolvedBy: string): Promise<Decision | null> {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      logger.warn('deny: decision not in cache', { decisionId });
    }

    const now = new Date();
    const resolution: Record<string, unknown> = { action: 'deny' };

    let updated: L2Decision | null = null;
    try {
      updated = await dbResolve(decisionId, resolvedBy, resolution, 'denied');
    } catch (err) {
      logger.error('db deny failed', {
        decisionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (decision) {
      decision.status = DecisionStatus.DENIED;
      decision.resolvedAt = now;
      decision.resolvedBy = resolvedBy;
      decision.action = 'deny';
    }

    // Notify any in-process waitForResolution() caller.
    const denyResolver = this.resolvers.get(decisionId);
    if (denyResolver) {
      this.resolvers.delete(decisionId);
      denyResolver(decision ?? null);
    }

    this.advanceQueue();
    return updated ? rowToDecision(updated) : (decision ?? null);
  }

  /**
   * Wait for a decision to be resolved/denied/expired. Returns the final
   * Decision (or null if not found / timed out). Used by the Web TS agent's
   * ask_question tool to block the workflow step until the user answers.
   */
  waitForResolution(decisionId: string, timeoutMs?: number): Promise<Decision | null> {
    // If already resolved, return immediately.
    const existing = this.decisions.get(decisionId);
    if (existing && (existing.status === DecisionStatus.RESOLVED || existing.status === DecisionStatus.DENIED || existing.status === DecisionStatus.EXPIRED || existing.status === DecisionStatus.TIMEOUT)) {
      return Promise.resolve(existing);
    }
    const wait = this.timeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(decisionId);
        resolve(this.decisions.get(decisionId) ?? null);
      }, timeoutMs ?? wait);
      this.resolvers.set(decisionId, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  }

  /**
   * Mark a decision expired. Persists to DB so the daemon callback can
   * read the final state.
   */
  async expire(decisionId: string): Promise<Decision | null> {
    const decision = this.decisions.get(decisionId);

    let updated: L2Decision | null = null;
    try {
      updated = await markExpired(decisionId, 'expired');
    } catch (err) {
      logger.error('db expire failed', {
        decisionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (decision) {
      decision.status = DecisionStatus.EXPIRED;
      decision.resolvedAt = new Date();
      decision.action = 'timeout';
    }

    this.advanceQueue();
    return updated ? rowToDecision(updated) : (decision ?? null);
  }

  /**
   * List all pending and sent decisions in FIFO order.
   * Synchronous — reads from the in-memory cache. Call
   * `await rehydrateFromDb()` once at boot to populate.
   */
  listPending(): Decision[] {
    const result: Decision[] = [];
    for (const id of this.pendingOrder) {
      const decision = this.decisions.get(id);
      if (decision && ACTIVE.includes(decision.status)) {
        result.push({ ...decision });
      }
    }
    return result;
  }

  /**
   * Get all currently "sent" decisions.
   */
  getSent(): Decision[] {
    const result: Decision[] = [];
    for (const decision of this.decisions.values()) {
      if (decision.status === DecisionStatus.SENT) {
        result.push({ ...decision });
      }
    }
    return result;
  }

  /**
   * Look up a decision by ID.
   */
  get(decisionId: string): Decision | null {
    const decision = this.decisions.get(decisionId);
    return decision ? { ...decision } : null;
  }

  /**
   * Count decisions matching the given status (DB-backed, async).
   */
  async count(status?: DecisionStatus): Promise<number> {
    if (!status) {
      // Total is approximate — use the cache.
      return this.decisions.size;
    }
    try {
      return await countByStatus(status);
    } catch {
      return 0;
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private initDecision(decision: Decision) {
    if (!decision.decisionId) {
      decision.decisionId = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    if (!decision.createdAt) {
      decision.createdAt = new Date();
    }
    if (!decision.timeoutAt) {
      decision.timeoutAt = new Date(
        decision.createdAt.getTime() + this.timeoutMs,
      );
    }
    if (!decision.status) {
      decision.status = DecisionStatus.PENDING;
    }
  }

  private canPromote(taskId: string): boolean {
    let sentCount = 0;
    let taskSentCount = 0;

    for (const decision of this.decisions.values()) {
      if (decision.status !== DecisionStatus.SENT) continue;
      sentCount++;
      if (decision.taskId === taskId) taskSentCount++;
    }

    if (sentCount === 0) return true;
    if (taskSentCount > 0 && taskSentCount < MAX_CONCURRENT_PER_TASK) {
      return true;
    }
    if (taskSentCount === 0) {
      for (const decision of this.decisions.values()) {
        if (
          decision.status === DecisionStatus.SENT &&
          decision.taskId !== taskId
        ) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  private promote(decisionId: string) {
    const decision = this.decisions.get(decisionId);
    if (decision) {
      decision.status = DecisionStatus.SENT;
    }
  }

  private advanceQueue() {
    for (const id of this.pendingOrder) {
      const decision = this.decisions.get(id);
      if (!decision || decision.status !== DecisionStatus.PENDING) continue;
      if (this.canPromote(decision.taskId)) {
        this.promote(id);
      }
    }
  }

  private startTimeoutMonitor() {
    this.checkInterval = setInterval(() => {
      this.checkTimeouts();
    }, 5000);
  }

  private checkTimeouts() {
    const now = new Date();
    for (const [id, decision] of this.decisions.entries()) {
      if (decision.status === DecisionStatus.SENT && now > decision.timeoutAt) {
        decision.status = DecisionStatus.TIMEOUT;
        decision.resolvedAt = now;
        decision.action = 'timeout';
        // Best-effort DB persist; don't block the timer.
        markExpired(id, 'timeout').catch((err) =>
          logger.error('timeout persist failed', {
            decisionId: id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
}

// ── DB row ↔ Decision converters ──────────────────────────────────

function rowToDecision(row: L2Decision): Decision {
  const p = row.payload ?? {};
  return {
    decisionId: row.decisionId,
    type:
      row.type in DecisionType
        ? (row.type as DecisionType)
        : DecisionType.L2_AUTH,
    taskId: row.taskId,
    sessionId: row.sessionId,
    agentId: row.agentId || undefined,
    nodeId: row.nodeId || undefined,
    status: row.status as DecisionStatus,
    createdAt: row.createdAt,
    timeoutAt: row.expiresAt,
    resolvedAt: row.resolvedAt || undefined,
    resolvedBy: row.resolvedBy || undefined,
    action: (row.resolution?.action as string | undefined) || undefined,
    answers:
      (row.resolution?.answers as string[][] | undefined) ||
      (p.answers as string[][] | undefined),
    command: p.command as string | undefined,
    score: p.score as number | undefined,
    reason: p.reason as string | undefined,
    question: p.question as string | undefined,
    options: p.options as string[] | undefined,
    prompts: p.prompts as Decision['prompts'],
    conflict: p.conflict as Decision['conflict'],
    branch: p.branch as Decision['branch'],
  };
}

function decisionToPayload(d: Decision): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (d.command !== undefined) p.command = d.command;
  if (d.score !== undefined) p.score = d.score;
  if (d.reason !== undefined) p.reason = d.reason;
  if (d.question !== undefined) p.question = d.question;
  if (d.options !== undefined) p.options = d.options;
  if (d.prompts !== undefined) p.prompts = d.prompts;
  if (d.conflict !== undefined) p.conflict = d.conflict;
  if (d.branch !== undefined) p.branch = d.branch;
  if (d.answers !== undefined) p.answers = d.answers;
  return p;
}
