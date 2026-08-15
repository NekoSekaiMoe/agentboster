export const dynamic = 'force-dynamic';

import {
  ingestTraceCallbackBatch,
  normalizeTraceCallbackBatch,
} from '../trace-callbacks';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.review-logs');

export async function POST(request: Request) {
  try {
    const requestBody = await request.json();
    const normalized = normalizeTraceCallbackBatch(requestBody, 'review');
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
    // Surface normalization skips (invalid items dropped before ingest)
    // alongside the ingest results so senders can see what was lost.
    const body =
      normalized.skippedIndices.length > 0
        ? { ...outcome.body, skippedIndices: normalized.skippedIndices }
        : outcome.body;
    return Response.json(body, { status: outcome.status });
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
