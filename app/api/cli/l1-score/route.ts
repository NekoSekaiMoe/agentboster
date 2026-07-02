/**
 * POST /api/cli/l1-score
 *
 * L1 security scoring for CLI-local command execution.
 *
 * The CLI runs tools on the user's own machine (no agentd), so the
 * agentd L1 path (/api/agentd/v1/l1-score via mTLS) does not apply.
 * This endpoint gives the CLI the same L1 LLM scoring the agentd path
 * gets, authenticated via the CLI's Bearer token instead of mTLS.
 *
 * Same scoring engine (lib/security/l1-scorer.ts), same KV cache
 * (lib/security/l1-cache.ts) — adding the CLI as a cache client is
 * fine because the cache key includes the model id and the command,
 * not the caller.
 *
 * Request body: { command: string, workDir?: string, contextSummary?: string }
 * Response: { ok: true, result: { score, level, reason } }
 */

import { withCliAuth } from '@/lib/cli/auth';
import { getConfig } from '@/lib/core/kv/config';
import {
  buildL1ScoreCacheKey,
  getCachedL1Score,
  resolveL1CacheTtlSeconds,
  setCachedL1Score,
} from '@/lib/security/l1-cache';
import { resolveL1ScorerModelId } from '@/lib/security/l1-model';
import { scoreCommand, type L1ScoreResult } from '@/lib/security/l1-scorer';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.cli.l1-score');

const requestSchema = z.object({
  command: z.string().min(1),
  workDir: z.string().optional(),
  contextSummary: z.string().optional(),
});

export const POST = withCliAuth(async (request) => {
  let parsed: z.infer<typeof requestSchema>;
  try {
    const body = await request.json();
    parsed = requestSchema.parse(body);
  } catch (error) {
    logger.error('invalid request', { error });
    return Response.json(
      { ok: false, error: 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const config = await getConfig();
    if (!config.models?.providers) {
      return Response.json(
        { ok: false, error: 'No model providers configured' },
        { status: 500 },
      );
    }

    const modelId = resolveL1ScorerModelId(config);
    const ttlSeconds = resolveL1CacheTtlSeconds(
      config.security?.l1_cache_ttl_seconds,
    );

    // Same cache logic as /api/agentd/v1/l1-score: low/medium are
    // cached, high/critical always miss. CLI repeats safe commands
    // (git status, ls) constantly — caching pays off the same way.
    const cacheKey = buildL1ScoreCacheKey({
      command: parsed.command,
      workDir: parsed.workDir,
      contextSummary: parsed.contextSummary,
      modelId,
    });
    const cached = await getCachedL1Score(cacheKey);
    if (cached) {
      return Response.json({ ok: true, result: cached });
    }

    const result: L1ScoreResult = await scoreCommand(
      {
        command: parsed.command,
        workDir: parsed.workDir,
        contextSummary: parsed.contextSummary,
      },
      modelId,
      config,
    );
    await setCachedL1Score(cacheKey, result, ttlSeconds);

    logger.info('cli command scored', {
      command: parsed.command.slice(0, 100),
      modelId,
      score: result.score,
      level: result.level,
    });
    return Response.json({ ok: true, result });
  } catch (error) {
    logger.error('cli l1 scoring failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { ok: false, error: 'Scoring failed' },
      { status: 500 },
    );
  }
});
