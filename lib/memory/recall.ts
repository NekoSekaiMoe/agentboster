import { listLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { scoreMemoryRelevance } from '@/lib/security/l1-scorer';
import type { AppConfig } from '@/types/config';
import { createLogger } from '@/lib/utils/logger';
import { searchLongTermMemories } from './long-term';

const logger = createLogger('memory.recall');

/**
 * Default number of long-term memories to auto-inject into the agent's
 * context per turn. Kept small to avoid drowning out the conversation
 * while still surfacing the most relevant personal context (location,
 * preferences, recent decisions). Tuned to match what a thoughtful
 * human assistant would keep in working memory.
 */
export const DEFAULT_RECALL_TOP_K = 5;

/**
 * Minimum normalised RRF score (0-1, see lib/memory/search.ts) for an
 * auto-recalled memory to be injected. Lower than the readMemory tool's
 * 0.05 default because auto-injection is best-effort: better to surface
 * a marginal match (the agent can ignore it) than to miss the relevant
 * fact entirely.
 */
export const DEFAULT_RECALL_MIN_CONFIDENCE = 0.02;

/**
 * Number of keyword candidates to retrieve before scoring. Keyword
 * matches are usually precise (substring / tsvector hits) so a smaller
 * pre-filter is enough.
 */
export const SCORER_KEYWORD_CANDIDATE_LIMIT = 10;

/**
 * Number of recency/importance candidates to retrieve when keyword
 * search returns nothing. These feed the scorer as a fallback candidate
 * pool so that personal-context queries ("我住哪", "我那个项目用什么栈")
 * that don't share surface form with stored memories can still be
 * resolved by the LLM's semantic judgment.
 */
export const SCORER_RECENCY_CANDIDATE_LIMIT = 20;

export interface RecalledMemory {
  content: string;
  score: number;
}

/**
 * Resolve the effective recall strategy.
 *
 * Explicit config wins. When unset, fall back to the strategy that
 * matches the deployment's reality:
 *   - `embedding_model` configured → 'vector' (existing users keep
 *     their behavior, no extra LLM cost).
 *   - `embedding_model` missing    → 'scorer' (keyword-only vector
 *     recall is near-useless for natural language; the scorer path is
 *     a strict improvement).
 */
export function resolveRecallStrategy(config: AppConfig): 'vector' | 'scorer' {
  const explicit = config.models?.memory_recall_strategy;
  if (explicit === 'vector' || explicit === 'scorer') {
    return explicit;
  }
  return config.models?.embedding_model ? 'vector' : 'scorer';
}

/**
 * Resolve the model id used by the scorer strategy. Prefers the L1
 * scorer model (cheap, structured-output-friendly), falls back to the
 * main chat model. Returns null when neither is configured — caller
 * should treat this as "scorer unavailable, fall back to keyword".
 */
export function resolveScorerModelId(config: AppConfig): string | null {
  return config.security?.l1_scorer_model ?? config.models?.model ?? null;
}

/**
 * Retrieve the top-K long-term memories relevant to a user's latest
 * message. Designed for auto-injection into the agent's context — the
 * agent never has to call readMemory proactively for personal-context
 * queries (location, preferences, schedule, etc.).
 *
 * Strategy dispatch (see {@link resolveRecallStrategy}):
 *   - 'vector': semantic + keyword hybrid search via pgvector. Requires
 *     `embedding_model`; degrades silently to keyword-only otherwise.
 *   - 'scorer': keyword pre-filter + LLM relevance scoring. Works
 *     without embeddings; costs one extra small-LLM call per message.
 *
 * Best-effort: returns an empty array when the user is anonymous, the
 * query is empty, the embedding model is not configured, or search
 * throws. Never rejects — callers can await without try/catch.
 */
export async function recallRelevantMemories(input: {
  userId?: string | null;
  query?: string | null;
  topK?: number;
  minConfidence?: number;
  config?: AppConfig;
}): Promise<RecalledMemory[]> {
  const userId = input.userId ?? null;
  const query = input.query?.trim();
  const topK = Math.max(1, input.topK ?? DEFAULT_RECALL_TOP_K);
  const minConfidence = input.minConfidence ?? DEFAULT_RECALL_MIN_CONFIDENCE;

  if (!userId || !query) {
    return [];
  }

  const config = input.config;
  const strategy = config ? resolveRecallStrategy(config) : 'vector';

  try {
    if (strategy === 'scorer' && config) {
      return await recallViaScorer({ userId, query, topK, config });
    }
    return await recallViaVector({ userId, query, topK, minConfidence });
  } catch (error) {
    logger.warn('recall:failed', {
      strategy,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Vector + keyword hybrid recall. Existing behavior preserved for
 * deployments that have `embedding_model` configured.
 */
async function recallViaVector(input: {
  userId: string;
  query: string;
  topK: number;
  minConfidence: number;
}): Promise<RecalledMemory[]> {
  const results = await searchLongTermMemories({
    query: input.query,
    minConfidence: input.minConfidence,
    pageSize: input.topK,
    userId: input.userId,
  });

  return results.map((row) => ({
    content: row.content,
    score: row.finalScore,
  }));
}

/**
 * Scorer-based recall: pull candidates via keyword + recency, then ask
 * a small LLM which ones are actually useful for the reply.
 *
 * Candidate sourcing:
 *  1. Keyword search (top SCORER_KEYWORD_CANDIDATE_LIMIT) — catches
 *     verbatim mentions.
 *  2. If keyword returned fewer than `topK`, top up from recency list
 *     (updatedAt desc, top SCORER_RECENCY_CANDIDATE_LIMIT) so the
 *     scorer sees recent high-signal memories even when the user's
 *     phrasing shares no surface form with stored content.
 *
 * The scorer is the source of truth: keyword hits are NOT auto-injected,
 * because ilike/tsvector matches on natural-language queries are noisy
 * (matches "我" against any memory containing "我", etc.). The LLM
 * filters them precisely.
 */
async function recallViaScorer(input: {
  userId: string;
  query: string;
  topK: number;
  config: AppConfig;
}): Promise<RecalledMemory[]> {
  const modelId = resolveScorerModelId(input.config);
  if (!modelId) {
    logger.info('scorer:no_model_available', { userId: input.userId });
    return [];
  }

  // Step 1: keyword candidates (cheap, precise when they hit).
  const keywordResults = await searchLongTermMemories({
    query: input.query,
    minConfidence: DEFAULT_RECALL_MIN_CONFIDENCE,
    pageSize: SCORER_KEYWORD_CANDIDATE_LIMIT,
    userId: input.userId,
  });

  // Step 2: top up with recency candidates when keyword underfilled.
  const candidates = keywordResults.map((row) => ({
    id: row.memoryId,
    content: row.content,
    score: row.finalScore,
  }));

  const seenIds = new Set(candidates.map((c) => c.id));
  if (candidates.length < Math.max(input.topK, 5)) {
    const recencyRows = await listLongTermMemoryRows({
      userId: input.userId,
      limit: SCORER_RECENCY_CANDIDATE_LIMIT,
    });
    for (const row of recencyRows) {
      if (seenIds.has(row.id)) continue;
      candidates.push({
        id: row.id,
        content: row.content,
        score: 0,
      });
      seenIds.add(row.id);
    }
  }

  if (candidates.length === 0) {
    logger.info('scorer:no_candidates', { userId: input.userId });
    return [];
  }

  // Step 3: ask the scorer which candidates are useful for the reply.
  const scored = await scoreMemoryRelevance({
    userMessage: input.query,
    candidates: candidates.map((c) => ({ id: c.id, content: c.content })),
    modelId,
    config: input.config,
  });

  if (scored.relevantIds.length === 0) {
    logger.info('scorer:no_relevant', {
      userId: input.userId,
      candidateCount: candidates.length,
    });
    return [];
  }

  // Step 4: preserve original order (candidate ranking) and cap at topK.
  const relevantSet = new Set(scored.relevantIds);
  return candidates
    .filter((c) => relevantSet.has(c.id))
    .slice(0, input.topK)
    .map((c) => ({
      content: c.content,
      // Mark scorer-selected memories with a synthetic high score so
      // downstream consumers (logs, future ranking) can distinguish
      // them from vector/keyword hits.
      score: c.score || 1,
    }));
}

/**
 * Format recalled memories into a single text block suitable for
 * injection as a system message. Returns null when there are no
 * memories to inject (caller should skip the system message entirely).
 */
export function formatRecalledMemoriesForContext(
  memories: RecalledMemory[],
): string | null {
  if (memories.length === 0) return null;

  const lines = memories.map((memory, index) => {
    return `${index + 1}. ${memory.content}`;
  });

  return [
    '[Relevant Long-term Memories]',
    "Auto-recalled from the user's stored long-term memory based on semantic relevance to their latest message. Use these as authoritative personal context — do NOT claim ignorance of facts listed here, and do NOT call readMemory to re-confirm them. If more detail is needed, call readMemory with a targeted query.",
    '',
    ...lines,
  ].join('\n');
}
