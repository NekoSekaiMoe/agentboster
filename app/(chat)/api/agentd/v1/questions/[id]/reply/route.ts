import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.questions.reply');

/**
 * POST /api/agentd/v1/questions/[id]/reply
 * Submits user answers to a pending question.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> } },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { answers } = body;

    if (!answers || !Array.isArray(answers)) {
      return Response.json(
        { success: false, error: 'Missing answers array' },
        { status: 400 },
      );
    }

    logger.info('Question reply received', {
      questionId: id,
      answers,
    });

    // In production, this would POST to the Go daemon's
    // POST /api/v1/questions/:id/reply endpoint
    // For now, log and return success

    return Response.json({
      success: true,
      data: { questionId: id },
    });
  } catch (error) {
    logger.error('Failed to reply to question', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to reply to question' },
      { status: 500 },
    );
  }
}
