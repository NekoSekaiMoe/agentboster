/**
 * L2 Decision Queue - Manages pending authorization requests
 * Moved from agentd/internal/security/l2_auth to clawless web layer
 */

import { z } from 'zod';

export const DecisionStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  RESOLVED: 'resolved',
  EXPIRED: 'expired',
  TIMEOUT: 'timeout',
  REJECTED: 'rejected',
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
  command: z.string().optional(),
  score: z.number().optional(),
  reason: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  status: z.nativeEnum(DecisionStatus),
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

/**
 * DecisionQueue serializes requests awaiting user action.
 * Decisions from different tasks are serialized; same-task decisions
 * can be concurrent up to MAX_CONCURRENT_PER_TASK.
 */
export class DecisionQueue {
  private decisions = new Map<string, Decision>();
  private pendingOrder: string[] = [];
  private checkInterval: NodeJS.Timeout | null = null;

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
   * Add a decision to the queue without blocking.
   * Returns true if the decision was immediately promoted to "sent".
   */
  enqueue(decision: Decision): boolean {
    this.initDecision(decision);
    this.decisions.set(decision.decisionId, { ...decision });
    this.pendingOrder.push(decision.decisionId);

    if (this.canPromote(decision.taskId)) {
      this.promote(decision.decisionId);
      return true;
    }
    return false;
  }

  /**
   * Mark a decision as resolved with the given action.
   */
  resolve(decisionId: string, action: string, resolvedBy: string): void {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new Error(`Decision ${decisionId} not found`);
    }

    const now = new Date();
    decision.status = DecisionStatus.RESOLVED;
    decision.resolvedAt = now;
    decision.resolvedBy = resolvedBy;
    decision.action = action;

    this.advanceQueue();
  }

  /**
   * Mark a decision as denied.
   */
  deny(decisionId: string, resolvedBy: string): void {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new Error(`Decision ${decisionId} not found`);
    }

    const now = new Date();
    decision.status = DecisionStatus.RESOLVED;
    decision.resolvedAt = now;
    decision.resolvedBy = resolvedBy;
    decision.action = 'deny';

    this.advanceQueue();
  }

  /**
   * Mark a decision as expired.
   */
  expire(decisionId: string): void {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      return;
    }

    decision.status = DecisionStatus.EXPIRED;
    decision.resolvedAt = new Date();
    decision.action = 'timeout';

    this.advanceQueue();
  }

  /**
   * List all pending and sent decisions in FIFO order.
   */
  listPending(): Decision[] {
    const result: Decision[] = [];
    for (const id of this.pendingOrder) {
      const decision = this.decisions.get(id);
      if (
        decision &&
        (decision.status === DecisionStatus.PENDING ||
          decision.status === DecisionStatus.SENT)
      ) {
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
   * Count decisions matching the given status.
   */
  count(status?: DecisionStatus): number {
    if (!status) {
      return this.decisions.size;
    }
    let n = 0;
    for (const decision of this.decisions.values()) {
      if (decision.status === status) {
        n++;
      }
    }
    return n;
  }

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
  }

  private canPromote(taskId: string): boolean {
    let sentCount = 0;
    let taskSentCount = 0;

    for (const decision of this.decisions.values()) {
      if (decision.status !== DecisionStatus.SENT) {
        continue;
      }
      sentCount++;
      if (decision.taskId === taskId) {
        taskSentCount++;
      }
    }

    if (sentCount === 0) {
      return true;
    }
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
      if (!decision || decision.status !== DecisionStatus.PENDING) {
        continue;
      }
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
    const expired: string[] = [];

    for (const [id, decision] of this.decisions.entries()) {
      if (decision.status === DecisionStatus.SENT && now > decision.timeoutAt) {
        decision.status = DecisionStatus.TIMEOUT;
        decision.resolvedAt = now;
        decision.action = 'timeout';
        expired.push(id);
      }
    }

    if (expired.length > 0) {
      this.advanceQueue();
    }
  }
}
