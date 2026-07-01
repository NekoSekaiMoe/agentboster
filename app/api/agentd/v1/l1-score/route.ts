/**
 * L1 Security Score API
 * Called by agentd to score commands and outputs for safety risks
 */

export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/core/kv/config';
import {
  buildL1ScoreCacheKey,
  getCachedL1Score,
  resolveL1CacheTtlSeconds,
  setCachedL1Score,
} from '@/lib/security/l1-cache';
import { resolveL1ScorerModelId } from '@/lib/security/l1-model';
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
  model_id: z.string().trim().min(1).optional(),
});

const outputScoreRequestSchema = z.object({
  type: z.literal('output'),
  output: z.string(),
  context_summary: z.string().optional(),
  model_id: z.string().trim().min(1).optional(),
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

    const modelId = resolveL1ScorerModelId(config, parsed.data.model_id);
    const ttlSeconds = resolveL1CacheTtlSeconds(
      config.security?.l1_cache_ttl_seconds,
    );
    let result: L1ScoreResult;
    if (parsed.data.type === 'command') {
      // L1 command scoring is the hot path: agents re-run safe commands
      // (git status, ls, cat) many times per session. Cache low/medium
      // verdicts in KV so repeat calls skip the LLM round-trip.
      const cacheKey = buildL1ScoreCacheKey({
        command: parsed.data.command,
        workDir: parsed.data.work_dir,
        contextSummary: parsed.data.context_summary,
        modelId,
      });
      const cached = await getCachedL1Score(cacheKey);
      if (cached) {
        logger.info('command score cache hit', {
          command: parsed.data.command.slice(0, 100),
          modelId,
          score: cached.score,
          level: cached.level,
        });
        return Response.json({ success: true, data: cached });
      }

      result = await scoreCommand(
        {
          command: parsed.data.command,
          workDir: parsed.data.work_dir,
          contextSummary: parsed.data.context_summary,
        },
        modelId,
        config,
      );
      await setCachedL1Score(cacheKey, result, ttlSeconds);
      logger.info('command scored', {
        command: parsed.data.command.slice(0, 100),
        modelId,
        score: result.score,
        level: result.level,
        cached: result.level === 'low' || result.level === 'medium',
      });
    } else {
      result = await scoreOutput(
        {
          output: parsed.data.output,
          contextSummary: parsed.data.context_summary,
        },
        modelId,
        config,
      );
      logger.info('output scored', {
        outputLength: parsed.data.output.length,
        modelId,
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
