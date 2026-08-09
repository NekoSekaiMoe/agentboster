/**
 * Automatic cleanup of sandbox resources when workflow completes.
 * Prevents resource leaks and reduces costs.
 *
 * Called by the post-run-cleanup workflow (lib/workflow/agent/post-run-cleanup.ts)
 * which is spawned fire-and-forget after chatWorkflow closes its UI stream.
 */

import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('workflow-cleanup');

export interface CleanupOptions {
  sessionId: string;
  /**
   * Whether to stop the sandbox. Default: false.
   * Set to true to immediately reclaim sandbox resources.
   * Leave false if you want sandbox to persist for subsequent
   * workflow runs in the same session (faster startup).
   */
  stopSandbox?: boolean;
}

/**
 * Cleanup resources after workflow completion.
 * Called by a step in the post-run-cleanup workflow, which is spawned
 * fire-and-forget after chatWorkflow closes its UI stream.
 */
export async function cleanupWorkflowResources(
  options: CleanupOptions,
): Promise<void> {
  const { sessionId, stopSandbox = false } = options;

  logger.info('cleanup:start', { sessionId, stopSandbox });

  const results = {
    sandboxStopped: false,
    errors: [] as string[],
  };

  // Stop sandbox if requested
  if (stopSandbox) {
    try {
      const { stopSessionSandbox } = await import('@/lib/core/sandbox/manager');
      await stopSessionSandbox(sessionId);
      results.sandboxStopped = true;
      logger.info('cleanup:sandbox_stopped', { sessionId });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Don't treat "not running" as an error
      if (!errorMsg.includes('not running')) {
        results.errors.push(`sandbox: ${errorMsg}`);
        logger.error('cleanup:sandbox_error', { sessionId, error: errorMsg });
      } else {
        logger.info('cleanup:sandbox_not_running', { sessionId });
      }
    }
  }

  logger.info('cleanup:complete', {
    sessionId,
    ...results,
    hasErrors: results.errors.length > 0,
  });
}
