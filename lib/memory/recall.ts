import { listLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import {
  getConnectedMemoryIds,
  getMemoryContentByIds,
} from '@/lib/core/db/memory/edges';
import { scoreMemoryRelevance } from '@/lib/security/l1-scorer';
import type { AppConfig } from '@/types/config';
import { createLogger } from '@/lib/utils/logger';
import {
  type CrossRerankConfig,
  crossRerankCandidates,
  resolveCrossRerankConfig,
} from './cross-reranker';
import { searchLongTermMemories } from './long-term';
import type { HybridSearchRow } from './search';

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

/**
 * Multiplier applied to `topK` to size the RRF candidate pool fed into
 * cross-rerank. Pulling more rows from RRF gives the reranker a wider
 * pool to cull from; the reranker then cuts it back down to `topK`.
 */
const CROSS_RERANK_POOL_MULTIPLIER = 4;

/**
 * Score decay per BFS hop. A memory found 1 hop from a seed gets
 * its score multiplied by HOP_DECAY × edge_weight. Set to 0.6 to
 * match the decay curve from graph-based memory retrieval research.
 */
const BFS_HOP_DECAY = 0.6;

/**
 * Overfetch multiplier for the initial seed pool before BFS expansion.
 * A wider seed pool gives BFS more starting points to discover related
 * memories through graph edges.
 */
const BFS_SEED_OVERFETCH = 3;

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
    return await recallViaVector({
      userId,
      query,
      topK,
      minConfidence,
      config,
    });
  } catch (error) {
    logger.warn('recall:failed', {
      strategy,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Vector + keyword hybrid recall with BFS graph expansion.
 *
 * Pipeline:
 *  1. Overfetch seeds via hybrid search (topK × BFS_SEED_OVERFETCH or
 *     wider if cross-rerank is enabled).
 *  2. Expand seeds 1 hop through memory_edges — connected memories get
 *     score = max_seed_score × HOP_DECAY × edge_weight.
 *  3. Merge seed and BFS results, deduplicated by memoryId.
 *  4. Optionally pass through cross-reranker.
 *  5. Return top-K.
 */
async function recallViaVector(input: {
  userId: string;
  query: string;
  topK: number;
  minConfidence: number;
  config?: AppConfig;
}): Promise<RecalledMemory[]> {
  const rerankConfig = resolveCrossRerankConfig(input.config);
  const rerankPoolSize = rerankConfig?.enabled
    ? Math.max(input.topK * CROSS_RERANK_POOL_MULTIPLIER, input.topK + 5)
    : input.topK;
  const poolSize = Math.max(rerankPoolSize, input.topK * BFS_SEED_OVERFETCH);

  const results = await searchLongTermMemories({
    query: input.query,
    minConfidence: input.minConfidence,
    pageSize: poolSize,
    userId: input.userId,
  });

  const merged = await expandWithBfs(results, input.topK);

  if (!rerankConfig?.enabled || merged.length <= input.topK) {
    return merged.slice(0, input.topK);
  }

  const reranked = await crossRerankCandidates({
    query: input.query,
    candidates: merged.map((m) => ({
      id: m.content,
      content: m.content,
      rrfScore: m.score,
    })),
    config: rerankConfig as CrossRerankConfig,
    topN: input.topK,
  });

  return reranked.map((row) => ({
    content: row.content,
    score: row.rrfScore,
  }));
}

/**
 * Expand seed results through graph edges (1 hop BFS).
 * Connected memories not already in the seed set are scored as
 * max_seed_score × HOP_DECAY × edge_weight and merged in.
 */
async function expandWithBfs(
  seeds: HybridSearchRow[],
  topK: number,
): Promise<RecalledMemory[]> {
  if (seeds.length === 0) return [];

  const seedMemoryIds = [...new Set(seeds.map((s) => s.memoryId))];
  const seedScoreMap = new Map<string, number>();
  for (const seed of seeds) {
    const existing = seedScoreMap.get(seed.memoryId) ?? 0;
    if (seed.finalScore > existing) {
      seedScoreMap.set(seed.memoryId, seed.finalScore);
    }
  }

  let connected: { memoryId: string; relation: string; weight: number }[] = [];
  try {
    connected = await getConnectedMemoryIds(seedMemoryIds);
  } catch {
    logger.info('bfs:edge_query_skipped');
  }

  const merged: RecalledMemory[] = seeds.map((s) => ({
    content: s.content,
    score: s.finalScore,
  }));

  if (connected.length === 0) return merged;

  const maxSeedScore = Math.max(...seedScoreMap.values());
  const newMemoryIds = connected
    .filter((c) => !seedScoreMap.has(c.memoryId))
    .map((c) => c.memoryId);

  if (newMemoryIds.length === 0) return merged;

  let contentMap: Map<string, string>;
  try {
    contentMap = await getMemoryContentByIds(newMemoryIds);
  } catch {
    return merged;
  }

  for (const conn of connected) {
    if (seedScoreMap.has(conn.memoryId)) continue;
    const content = contentMap.get(conn.memoryId);
    if (!content) continue;

    const bfsScore = maxSeedScore * BFS_HOP_DECAY * conn.weight;
    merged.push({ content, score: bfsScore });
  }

  logger.info('bfs:expanded', {
    seedCount: seedMemoryIds.length,
    connectedCount: connected.length,
    newCount: newMemoryIds.length,
  });

  merged.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const deduped: RecalledMemory[] = [];
  for (const m of merged) {
    if (seen.has(m.content)) continue;
    seen.add(m.content);
    deduped.push(m);
    if (deduped.length >= topK * 2) break;
  }

  return deduped;
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
 *
 * Uses anti-lost-in-middle reordering: highest-scored memories are
 * placed at the beginning and end of the list, since LLMs attend more
 * to the edges of their context window than the middle.
 */
export function formatRecalledMemoriesForContext(
  memories: RecalledMemory[],
): string | null {
  if (memories.length === 0) return null;

  const reordered = antiLostInMiddle(memories);

  const lines = reordered.map((memory, index) => {
    return `${index + 1}. ${memory.content}`;
  });

  return [
    '[Relevant Long-term Memories]',
    "Auto-recalled from the user's stored long-term memory based on semantic relevance to their latest message. Use these as authoritative personal context — do NOT claim ignorance of facts listed here, and do NOT call readMemory to re-confirm them. If more detail is needed, call readMemory with a targeted query.",
    '',
    ...lines,
  ].join('\n');
}

/**
 * Reorder items so the highest-scored entries sit at the edges (start
 * and end) of the list, pushing lower-scored items into the middle.
 *
 * Input must be sorted by score descending. Output alternates placement:
 *   rank 0 → head, rank 1 → tail, rank 2 → head, rank 3 → tail, ...
 *
 * This counteracts the "lost in the middle" effect observed in LLMs,
 * where items in the center of a long context receive less attention.
 */
function antiLostInMiddle<T>(items: T[]): T[] {
  if (items.length <= 2) return items;

  const head: T[] = [];
  const tail: T[] = [];

  for (let i = 0; i < items.length; i++) {
    if (i % 2 === 0) {
      head.push(items[i]);
    } else {
      tail.unshift(items[i]);
    }
  }

  return [...head, ...tail];
}
