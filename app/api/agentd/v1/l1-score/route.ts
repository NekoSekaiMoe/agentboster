/**
 * L1 Security Score API
 * Called by agentd to score commands and outputs for safety risks
 */

import { getConfig } from '@/lib/core/kv/config';
import {
  type L1ScoreResult,
  scoreCommand,
  scoreOutput,
} from '@/lib/security/l1-scorer';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.l1-score');

const commandScoreRequestSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  work_dir: z.string().optional(),
  context_summary: z.string().optional(),
  model_id: z.string().default('openai/gpt-4o-mini'),
});

const outputScoreRequestSchema = z.object({
  type: z.literal('output'),
  output: z.string(),
  context_summary: z.string().optional(),
  model_id: z.string().default('openai/gpt-4o-mini'),
});

const requestSchema = z.discriminatedUnion('type', [
  commandScoreRequestSchema,
  outputScoreRequestSchema,
]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      logger.error('invalid request', { error: parsed.error });
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

    // Check if L1 scorer model is configured
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

    let result: L1ScoreResult;
    if (parsed.data.type === 'command') {
      result = await scoreCommand(
        {
          command: parsed.data.command,
          workDir: parsed.data.work_dir,
          contextSummary: parsed.data.context_summary,
        },
        parsed.data.model_id,
        config,
      );
      logger.info('command scored', {
        command: parsed.data.command.slice(0, 100),
        score: result.score,
        level: result.level,
      });
    } else {
      result = await scoreOutput(
        {
          output: parsed.data.output,
          contextSummary: parsed.data.context_summary,
        },
        parsed.data.model_id,
        config,
      );
      logger.info('output scored', {
        outputLength: parsed.data.output.length,
        score: result.score,
        level: result.level,
      });
    }

    return Response.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('scoring failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'Scoring failed',
      },
      { status: 500 },
    );
  }
}
