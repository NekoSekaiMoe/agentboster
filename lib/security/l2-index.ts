import { DecisionQueue, type Decision } from './l2-decision-queue';

// Singleton instance for the application
let queue: DecisionQueue | null = null;

export function getDecisionQueue(): DecisionQueue {
  if (!queue) {
    queue = new DecisionQueue();
  }
  return queue;
}

export type { Decision };
