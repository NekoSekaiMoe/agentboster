import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('memory.cross_reranker');

/**
 * Cross-encoder reranker for the 'vector' recall strategy.
 *
 * Inserts a dedicated relevance model (Qwen3-Reranker-8B,
 * bge-reranker-v2-m3, Jina/Cohere rerank APIs, …) between RRF fusion
 * and the top-K cut. One small HTTP call returns continuous scores in
 * ~300ms-3s with zero token cost, and produces finer-grained ranking
 * than LLM-as-reranker (which the 'scorer' strategy already covers —
 * cross-rerank is not applied there to avoid double cost).
 *
 * Failure modes are all fail-open: empty input, short candidate pool,
 * network errors, malformed responses, and missing config all return
 * the input order unchanged so the main recall path is never blocked.
 *
 * Protocol support mirrors Afterglow's Python client:
 *   - 'jina'     : Jina / SiliconFlow / Cohere v2 / self-hosted
 *                  bge-reranker services. Flat `results: [{index,
 *                  relevance_score}]` envelope.
 *   - 'dashscope': Alibaba DashScope text-rerank. Result nested under
 *                  `output.results`.
 */

export interface RerankCandidate {
  /** Stable id used for join-back (memoryId or chunkId). */
  id: string;
  /** Document text fed to the reranker. */
  content: string;
  /** Original RRF/keyword score (preserved on the returned row). */
  rrfScore: number;
}

export interface RerankedCandidate extends RerankCandidate {
  /**
   * Relevance score from the reranker, or `null` when the candidate
   * was carried over via fail-open passthrough (no upstream score).
   */
  rerankScore: number | null;
  /**
   * Provenance tag for debugging:
   *   - 'model'        : selected by the upstream reranker
   *   - 'passthrough'  : candidate pool ≤ top_n, upstream not called
   *   - 'error'        : upstream call failed, original order preserved
   *   - 'empty'        : upstream returned no results
   *   - 'fill'         : upstream omitted this index, filled from RRF order
   */
  rerankSource: 'model' | 'passthrough' | 'error' | 'empty' | 'fill';
}

export interface CrossRerankConfig {
  enabled: boolean;
  protocol: 'jina' | 'dashscope';
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  topN?: number;
  timeoutSeconds: number;
}

type NormalizedRerankResult = Array<{ index: number; score: number }>;

/** Default request timeout (seconds). */
const DEFAULT_TIMEOUT_SECONDS = 10;

/** Default top_n when unset — caller's topK is the natural cap. */
const DEFAULT_TOP_N = 5;

/**
 * Resolve the effective cross-rerank config from AppConfig, honoring
 * the legacy `cross_rerank_enabled` scalar for backward compatibility.
 * Returns `null` when reranking is disabled or no config is present.
 */
export function resolveCrossRerankConfig(
  config: AppConfig | undefined,
): CrossRerankConfig | null {
  if (!config?.models) {
    return null;
  }

  const models = config.models;
  const structured = models.cross_rerank;
  const legacyEnabled = models.cross_rerank_enabled === true;

  if (!structured && !legacyEnabled) {
    return null;
  }

  if (structured && (structured.enabled ?? true) === false) {
    return null;
  }

  if (!structured) {
    return {
      enabled: true,
      protocol: 'jina',
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    };
  }

  return {
    enabled: structured.enabled ?? legacyEnabled,
    protocol: structured.protocol ?? 'jina',
    model: structured.model,
    apiUrl: structured.api_url,
    apiKey: structured.api_key,
    topN: structured.top_n,
    timeoutSeconds: structured.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

/**
 * Rerank `candidates` by relevance to `query`. Returns a list capped
 * at `topN`, reordered by the upstream model's relevance score.
 *
 * Fail-open contract:
 *   - `candidates.length <= topN` → no HTTP call, passthrough.
 *   - Upstream error / empty / malformed → original RRF order, capped.
 *   - Upstream missing some indices → fill from RRF order until topN.
 *
 * The original `rrfScore` is always preserved on the returned rows;
 * the reranker's score is exposed as `rerankScore` for observability.
 */
export async function crossRerankCandidates(input: {
  query: string;
  candidates: RerankCandidate[];
  config: CrossRerankConfig;
  topN: number;
}): Promise<RerankedCandidate[]> {
  const { query, candidates, config } = input;
  const topN = Math.max(1, input.topN ?? config.topN ?? DEFAULT_TOP_N);

  if (candidates.length === 0) {
    return [];
  }

  if (candidates.length <= topN) {
    return candidates.map((c) => ({
      ...c,
      rerankScore: null,
      rerankSource: 'passthrough' as const,
    }));
  }

  if (!config.apiUrl || !config.apiKey || !config.model) {
    logger.info('cross_rerank:skipped_no_config', {
      candidateCount: candidates.length,
    });
    return candidates.slice(0, topN).map((c) => ({
      ...c,
      rerankScore: null,
      rerankSource: 'passthrough' as const,
    }));
  }

  const documents = candidates.map((c) => c.content);
  let results: NormalizedRerankResult;
  try {
    results = await callRerankerService({
      query,
      documents,
      topN,
      config,
    });
  } catch (error) {
    logger.warn('cross_rerank:upstream_error', {
      error: error instanceof Error ? error.message : String(error),
      candidateCount: candidates.length,
    });
    return candidates.slice(0, topN).map((c) => ({
      ...c,
      rerankScore: null,
      rerankSource: 'error' as const,
    }));
  }

  if (results.length === 0) {
    logger.info('cross_rerank:empty_results', {
      candidateCount: candidates.length,
    });
    return candidates.slice(0, topN).map((c) => ({
      ...c,
      rerankScore: null,
      rerankSource: 'empty' as const,
    }));
  }

  const reordered: RerankedCandidate[] = [];
  const seen = new Set<number>();

  for (const { index, score } of results) {
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      continue;
    }
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    reordered.push({
      ...candidate,
      rerankScore: roundScore(score),
      rerankSource: 'model',
    });
    if (reordered.length >= topN) {
      break;
    }
  }

  for (let i = 0; i < candidates.length && reordered.length < topN; i++) {
    if (seen.has(i)) {
      continue;
    }
    reordered.push({
      ...candidates[i],
      rerankScore: null,
      rerankSource: 'fill',
    });
  }

  return reordered;
}

async function callRerankerService(input: {
  query: string;
  documents: string[];
  topN: number;
  config: CrossRerankConfig;
}): Promise<NormalizedRerankResult> {
  const { query, documents, topN, config } = input;
  const url = resolveRerankUrl(config);
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  const payload =
    config.protocol === 'dashscope'
      ? {
          model: config.model,
          input: { query, documents },
          parameters: { top_n: topN, return_documents: false },
        }
      : {
          model: config.model,
          query,
          documents,
          top_n: topN,
          return_documents: false,
        };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
  });

  if (!response.ok) {
    throw new Error(
      `rerank HTTP ${response.status}: ${await safeReadErrorBody(response)}`,
    );
  }

  const data = (await response.json()) as unknown;
  return parseRerankResponse(data, config.protocol);
}

/**
 * Build the full rerank endpoint URL from the configured base.
 *
 * A path is considered "already complete" only when it contains a
 * known rerank suffix (`/rerank` for jina-style, `text-rerank` for
 * dashscope). A bare host or a base ending in an API version like
 * `/v1` is treated as needing the suffix appended.
 */
export function resolveRerankUrl(config: CrossRerankConfig): string {
  const base = (config.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    return config.protocol === 'dashscope'
      ? '/services/rerank/text-rerank/text-rerank'
      : '/rerank';
  }

  if (config.protocol === 'dashscope') {
    return base.includes('text-rerank')
      ? base
      : `${base}/services/rerank/text-rerank/text-rerank`;
  }

  return base.includes('/rerank') ? base : `${base}/rerank`;
}

/**
 * Parse the rerank service response into a normalized
 * `(index, score)` list. Exported for unit testing.
 */
export function parseRerankResponse(
  data: unknown,
  protocol: 'jina' | 'dashscope',
): NormalizedRerankResult {
  const envelope =
    protocol === 'dashscope' ? (readField(data, 'output') ?? data) : data;
  const results = readField(envelope, 'results');
  if (!Array.isArray(results)) {
    return [];
  }

  const out: NormalizedRerankResult = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const index = readField(item, 'index');
    const score =
      readField(item, 'relevance_score') ?? readField(item, 'score');
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      continue;
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      continue;
    }
    out.push({ index, score });
  }
  return out;
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

async function safeReadErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return '<no body>';
  }
}

function roundScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.round(score * 10000) / 10000;
}
