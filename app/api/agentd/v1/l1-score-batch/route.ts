/**
 * Batched L1 Security Score API.
 * Called by agentd when exec_batch needs a single cross-command review.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveLanguageModel } from '@/lib/ai';
import { getConfig } from '@/lib/core/kv/config';
import { resolveL1ScorerModelId } from '@/lib/security/l1-model';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l1-score-batch');

const batchScoreRequestSchema = z.object({
  type: z.literal('command_batch'),
  prompt: z.string().min(1),
  context_summary: z.string().optional(),
  model_id: z.string().trim().min(1).optional(),
});

const batchScoreResultSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      level: z.enum(['allow', 'low', 'medium', 'high', 'block']),
      reason: z.string(),
    }),
  ),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = batchScoreRequestSchema.safeParse(body);

    if (!parsed.success) {
      logger.error('invalid batch request', { error: parsed.error });
      return Response.json(
        {
          success: false,
          error: 'Invalid request',
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const config = await getConfig();
    if (!config.models?.providers) {
      logger.error('no model providers configured');
      return Response.json(
        {
          success: false,
          error: 'No model providers configured',
        },
        { status: 500 },
      );
    }

    const modelId = resolveL1ScorerModelId(config, parsed.data.model_id);
    const model = resolveLanguageModel(modelId, config);
    const { object } = await generateObject({
      model,
      schema: batchScoreResultSchema,
      prompt: parsed.data.prompt,
    });

    logger.info('batch scored', {
      count: object.results.length,
      modelId,
    });

    return Response.json({
      success: true,
      data: object,
    });
  } catch (error) {
    logger.error('batch scoring failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'Batch scoring failed',
      },
      { status: 500 },
    );
  }
}
