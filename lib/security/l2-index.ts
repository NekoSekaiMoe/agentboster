import { DecisionQueue } from './l2-decision-queue';
import { expireStaleDecisions } from '@/lib/core/db/l2-decisions';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('security.l2-index');

// Singleton instance for the application.
let queue: DecisionQueue | null = null;
let sweeperTimer: NodeJS.Timeout | null = null;
let rehydratePromise: Promise<void> | null = null;

export function getDecisionQueue(): DecisionQueue {
  if (!queue) {
    queue = new DecisionQueue();
    // Kick off DB rehydration in the background. Routes that need the
    // hydrated state should await `awaitRehydrated()`.
    void rehydrateQueue();
    // Sweeper: mark stale decisions expired so they get forwarded as
    // rejections to the originating daemon nodes (otherwise those
    // tasks would hang forever waiting for a reply that never comes).
    if (!sweeperTimer) {
      sweeperTimer = setInterval(
        () => {
          expireStaleDecisions().catch((err) =>
            logger.error('sweeper failed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        },
        30 * 1000, // 30s
      );
      sweeperTimer.unref?.();
    }
  }
  return queue;
}

/** Resolved when the queue has rehydrated active decisions from the DB. */
export function awaitRehydrated(): Promise<void> {
  if (rehydratePromise) return rehydratePromise;
  return Promise.resolve();
}

async function rehydrateQueue() {
  if (!queue) return;
  rehydratePromise = queue.rehydrateFromDb();
  try {
    await rehydratePromise;
  } catch (err) {
    logger.error('rehydrate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Decision } from './l2-decision-queue';
