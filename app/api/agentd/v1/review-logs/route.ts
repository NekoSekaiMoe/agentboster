export const dynamic = 'force-dynamic';

import {
  ingestTraceCallbackBatch,
  normalizeTraceCallbackBatch,
} from '../trace-callbacks';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.review-logs');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const normalized = normalizeTraceCallbackBatch(body, 'review');
    if ('error' in normalized) {
      return Response.json(
        { success: false, error: normalized.error },
        { status: 400 },
      );
    }
    const outcome = await ingestTraceCallbackBatch(normalized.callbacks);
    if (outcome.body.success === false) {
      logger.error('review log write failed', { error: outcome.body.error });
      return Response.json(outcome.body, { status: outcome.status });
    }
    return Response.json(outcome.body, { status: outcome.status });
  } catch (error) {
    logger.error('review log write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to write review logs' },
      { status: 500 },
    );
  }
}
