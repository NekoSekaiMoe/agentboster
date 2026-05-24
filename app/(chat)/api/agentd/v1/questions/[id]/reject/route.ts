import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.questions.reject');

/**
 * POST /api/agentd/v1/questions/[id]/reject
 * Dismisses a pending question.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }>,
) {
  try {
    const { id } = await params;

    logger.info('Question rejected', { questionId: id });

    // In production, this would POST to the Go daemon's
    // POST /api/v1/questions/:id/reject endpoint

    return Response.json({
      success: true,
      data: { questionId: id },
    });
  } catch (error) {
    logger.error('Failed to reject question', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to reject question' },
      { status: 500 },
    );
  }
}
