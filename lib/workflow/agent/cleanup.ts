/**
 * Automatic cleanup of browser sessions and sandbox resources when
 * workflow completes. Prevents resource leaks and reduces costs.
 *
 * Called by dispatch.ts after the workflow stream closes.
 */

import { getBrowserPool } from '@/lib/mcp/browser/pool';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('workflow-cleanup');

export interface CleanupOptions {
  sessionId: string;
  /**
   * Whether to close browser sessions. Default: true.
   * Set to false if you want browser sessions to persist across
   * multiple workflow runs in the same chat session.
   */
  closeBrowser?: boolean;
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
 * Called automatically by dispatch.ts when the workflow stream closes.
 */
export async function cleanupWorkflowResources(
  options: CleanupOptions,
): Promise<void> {
  const { sessionId, closeBrowser = true, stopSandbox = false } = options;

  logger.info('cleanup:start', { sessionId, closeBrowser, stopSandbox });

  const results = {
    browserClosed: false,
    sandboxStopped: false,
    errors: [] as string[],
  };

  // Close browser session if requested
  if (closeBrowser) {
    try {
      const closed = await getBrowserPool().close(sessionId);
      results.browserClosed = closed;
      if (closed) {
        logger.info('cleanup:browser_closed', { sessionId });
      } else {
        logger.info('cleanup:no_browser_session', { sessionId });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.errors.push(`browser: ${errorMsg}`);
      logger.error('cleanup:browser_error', { sessionId, error: errorMsg });
    }
  }

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
