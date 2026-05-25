import type { ScoreRequest } from '../scorer/types';
import type { L1Result } from './index';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: L1Result;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function buildCacheKey(req: ScoreRequest): string {
  const action = req.action;
  const cmd = req.command ?? '';
  const wd = req.context.workingDirectory;
  return `${action}:${cmd}:${wd}`;
}

export function getCachedL1Result(req: ScoreRequest): L1Result | null {
  const key = buildCacheKey(req);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCachedL1Result(req: ScoreRequest, result: L1Result): void {
  const key = buildCacheKey(req);
  cache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function clearL1Cache(): void {
  cache.clear();
}

export function cleanupExpiredL1Cache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(key);
    }
  }
}
