export interface HybridSearchRow {
  chunkId: string;
  memoryId: string;
  content: string;
  vectorScore: number;
  keywordScore: number;
  finalScore: number;
}

export interface VectorSearchCandidate {
  chunkId: string;
  memoryId: string;
  content: string;
  vectorScore: number;
  /** Memory importance (1-10, default 5). Higher importance resists decay. */
  importance?: number;
  /** Last access timestamp for decay calculation. */
  lastAccessedAt?: string | Date | null;
}

export interface KeywordSearchCandidate {
  chunkId: string;
  memoryId: string;
  content: string;
  keywordScore: number;
}

const DEFAULT_CANDIDATE_POOL = 20;
const MAX_CANDIDATE_POOL = 200;

/** RRF constant k — controls how quickly rank position diminishes score contribution. */
const RRF_K = 60;

/**
 * Theoretical maximum RRF score: a chunk ranked #0 in BOTH the vector and
 * keyword lists contributes `1/(RRF_K+1)` from each, so
 * `MAX_RRF_SCORE = 2 / (RRF_K + 1)`. Used to normalise `finalScore` to the
 * 0-1 range so `minConfidence` thresholds read as intuitive percentages
 * (0.5 ≈ "very strong match", 0.1 ≈ "weak but above noise").
 */
const MAX_RRF_SCORE = 2 / (RRF_K + 1);

/** Default decay rate for memory aging. Higher = faster decay. */
const DEFAULT_DECAY_RATE = 0.05;

export function buildMemorySearchText(input: {
  query?: string;
  keywords?: string[];
}) {
  const query = input.query?.trim();
  if (query) {
    return query;
  }

  const joinedKeywords = input.keywords?.join(' ').trim();
  return joinedKeywords || '';
}

export function getHybridCandidateLimit(input: {
  limit: number;
  offset: number;
}) {
  return Math.min(
    Math.max(
      input.limit + input.offset,
      input.limit * 3,
      DEFAULT_CANDIDATE_POOL,
    ),
    MAX_CANDIDATE_POOL,
  );
}

/**
 * Compute time-based decay factor for a memory chunk.
 *
 * Formula: e^(-decayRate × daysSinceLastAccess / importance)
 * - importance=10 decays very slowly (high-importance memories persist)
 * - importance=1 decays quickly (low-importance memories fade)
 * - No lastAccessedAt → no decay applied (factor = 1.0)
 */
function computeDecayFactor(input: {
  lastAccessedAt?: string | Date | null;
  importance?: number;
  decayRate?: number;
}): number {
  if (!input.lastAccessedAt) {
    return 1.0;
  }

  const accessed =
    input.lastAccessedAt instanceof Date
      ? input.lastAccessedAt
      : new Date(input.lastAccessedAt);

  if (Number.isNaN(accessed.getTime())) {
    return 1.0;
  }

  const now = Date.now();
  const daysSince = (now - accessed.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince <= 0) {
    return 1.0;
  }

  const importance = input.importance ?? 5;
  const decayRate = input.decayRate ?? DEFAULT_DECAY_RATE;
  return Math.exp((-decayRate * daysSince) / importance);
}

/**
 * Merge vector and keyword search results using Reciprocal Rank Fusion (RRF)
 * with optional time-based decay.
 *
 * RRF formula: score = Σ 1/(k + rank), k=60
 * - Each result list contributes 1/(k + rank) to the fused score
 * - No fixed weights needed — the ranking position determines influence
 * - Precise keyword matches rank high in keyword list → naturally dominate
 * - Semantic matches rank high in vector list → naturally dominate
 *
 * After RRF fusion, an optional decay factor is applied:
 *   finalScore = rrfScore × decayFactor
 * where decayFactor = e^(-decayRate × daysSinceLastAccess / importance)
 */
export function mergeHybridSearchCandidates(input: {
  vectorRows: VectorSearchCandidate[];
  keywordRows: KeywordSearchCandidate[];
  minConfidence: number;
  limit: number;
  offset: number;
  /** Decay rate (0.0 ~ 1.0). Default 0.05. Set to 0 to disable decay. */
  decayRate?: number;
}): HybridSearchRow[] {
  const rrfScores = new Map<
    string,
    {
      chunkId: string;
      memoryId: string;
      content: string;
      vectorScore: number;
      keywordScore: number;
      rrfScore: number;
      importance: number;
      lastAccessedAt: string | Date | null;
    }
  >();

  // Vector rows: sorted by vectorScore DESC (assumed pre-sorted by caller)
  for (const [rank, row] of input.vectorRows.entries()) {
    rrfScores.set(row.chunkId, {
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      content: row.content,
      vectorScore: row.vectorScore,
      keywordScore: 0,
      rrfScore: 1 / (RRF_K + rank + 1),
      importance: row.importance ?? 5,
      lastAccessedAt: row.lastAccessedAt ?? null,
    });
  }

  // Keyword rows: sorted by keywordScore DESC (assumed pre-sorted by caller)
  for (const [rank, row] of input.keywordRows.entries()) {
    const existing = rrfScores.get(row.chunkId);
    if (existing) {
      existing.keywordScore = row.keywordScore;
      existing.rrfScore += 1 / (RRF_K + rank + 1);
      continue;
    }

    rrfScores.set(row.chunkId, {
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      content: row.content,
      vectorScore: 0,
      keywordScore: row.keywordScore,
      rrfScore: 1 / (RRF_K + rank + 1),
      importance: 5,
      lastAccessedAt: null,
    });
  }

  // Apply decay factor and build final rows
  const decayRate = input.decayRate ?? DEFAULT_DECAY_RATE;
  const rows: HybridSearchRow[] = [];

  for (const entry of rrfScores.values()) {
    const decayFactor =
      decayRate > 0
        ? computeDecayFactor({
            lastAccessedAt: entry.lastAccessedAt,
            importance: entry.importance,
            decayRate,
          })
        : 1.0;

    rows.push({
      chunkId: entry.chunkId,
      memoryId: entry.memoryId,
      content: entry.content,
      vectorScore: entry.vectorScore,
      keywordScore: entry.keywordScore,
      // Normalise to 0-1: a perfect double-rank-0 match with no decay = 1.0.
      finalScore: (entry.rrfScore * decayFactor) / MAX_RRF_SCORE,
    });
  }

  return rows
    .filter((row) => row.finalScore >= input.minConfidence)
    .sort((left, right) => {
      if (right.finalScore !== left.finalScore) {
        return right.finalScore - left.finalScore;
      }
      if (right.vectorScore !== left.vectorScore) {
        return right.vectorScore - left.vectorScore;
      }
      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }
      return left.chunkId.localeCompare(right.chunkId);
    })
    .slice(input.offset, input.offset + input.limit);
}
