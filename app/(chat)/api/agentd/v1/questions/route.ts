import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.questions');

/**
 * GET /api/agentd/v1/questions
 * Lists all pending questions from the agent.
 * The actual question data lives in the Go daemon's memory,
 * so this proxies to the daemon or returns from KV.
 */
export async function GET() {
  try {
    // For now, return empty — the Go daemon's question service is the source of truth
    // In production, this would query the Go daemon's GET /api/v1/questions endpoint
    return Response.json({
      success: true,
      data: [],
    });
  } catch (error) {
    logger.error('Failed to list questions', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to list questions' },
      { status: 500 },
    );
  }
}
