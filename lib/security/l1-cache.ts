/**
 * L1 score cache (KV-backed).
 *
 * The L1 scorer calls an LLM via generateObject on every request. Within
 * a single agent session the same low/medium-risk command (e.g.
 * `git status`, `ls`, `cat file`) is scored repeatedly with identical
 * context — those calls are pure waste. This cache short-circuits them.
 *
 * Design notes:
 *   - Backed by the shared KV (Upstash Redis), so hits land across
 *     serverless instances, not just within one process.
 *   - Key includes command + workDir + contextSummary + resolved modelId
 *     hash. Switching the scorer model invalidates the cache naturally.
 *   - Only `low` and `medium` results are cached. `high`/`critical`
 *     judgments are context-sensitive and must always be re-evaluated
 *     (a later command in the same session may change the risk picture).
 *   - Failures to read/write the cache are swallowed and logged — the
 *     scorer must still return a correct result; the cache is a pure
 *     optimization.
 */
import type { L1ScoreResult } from '@/lib/security/l1-scorer';
import { createLogger } from '@/lib/utils/logger';
import { createHash } from 'node:crypto';
import { getKV } from '@/lib/core/kv';

const logger = createLogger('security.l1-cache');

const KEY_PREFIX = 'l1:score:';
/** Default TTL in seconds when the config does not override it. */
export const DEFAULT_L1_CACHE_TTL_SECONDS = 5 * 60;
/** Disable caching entirely when set to 0. */
const L1_CACHE_DISABLED = 0;
/** Cap absurdly large TTLs to avoid pinning stale low-risk verdicts forever. */
const MAX_L1_CACHE_TTL_SECONDS = 60 * 60; // 1h

/** Levels that are safe to return from cache. high/critical always miss. */
const CACHEABLE_LEVELS = new Set<L1ScoreResult['level']>(['low', 'medium']);

/**
 * Build the cache key for a command-score request.
 *
 * The key intentionally includes the resolved modelId (different models
 * give different verdicts) and the full contextSummary, so two sessions
 * with different context do not share verdicts.
 */
export function buildL1ScoreCacheKey(input: {
  command: string;
  workDir?: string;
  contextSummary?: string;
  modelId: string;
}): string {
  const payload = [
    input.command,
    input.workDir ?? '',
    input.contextSummary ?? '',
    input.modelId,
  ].join('\u0000');
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${KEY_PREFIX}${hash}`;
}

/** Normalize the TTL read from config into seconds, applying bounds. */
export function resolveL1CacheTtlSeconds(configured?: number): number {
  if (configured === undefined || configured === null) {
    return DEFAULT_L1_CACHE_TTL_SECONDS;
  }
  if (configured <= 0) return L1_CACHE_DISABLED;
  return Math.min(configured, MAX_L1_CACHE_TTL_SECONDS);
}

/**
 * Look up a cached L1 command score. Returns null on miss, on any KV
 * error, and for non-cacheable levels stored in KV from an older code
 * path (defensive).
 */
export async function getCachedL1Score(
  key: string,
): Promise<L1ScoreResult | null> {
  try {
    const raw = await getKV().get<string>(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as L1ScoreResult;
    // Defensive: if a stale high/critical entry slipped in (e.g. from a
    // future level rename), treat it as a miss instead of trusting it.
    if (!CACHEABLE_LEVELS.has(parsed.level)) return null;
    return parsed;
  } catch (err) {
    logger.error('l1 cache read failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store an L1 command score in the cache. No-op for non-cacheable levels
 * (high/critical) and when the TTL is disabled (0). Errors are swallowed.
 */
export async function setCachedL1Score(
  key: string,
  result: L1ScoreResult,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  if (!CACHEABLE_LEVELS.has(result.level)) return;
  try {
    await getKV().set(key, JSON.stringify(result), { ex: ttlSeconds });
  } catch (err) {
    logger.error('l1 cache write failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
