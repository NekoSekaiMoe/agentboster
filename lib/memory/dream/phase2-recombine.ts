/**
 * Phase 2 — Recombine.
 *
 * Surfaces NOVEL cross-cluster connections the consolidator missed.
 * Outputs are `PROPOSE` operations that apply.ts writes as `tentative`
 * memories (key prefix `dream.proposal.*`), pending ratification.
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/orchestrator.py
 * ::_run_recombine + schemas.ProposedFinding. Their implementation uses
 * Graphiti graph traversal to find weak links between entity clusters;
 * agentboster has no graph DB, so we use embedding similarity across
 * DIFFERENT key-prefix groups to seed the LLM with candidate pairs the
 * consolidator wouldn't have considered (it only merges WITHIN a group).
 *
 * Pipeline:
 *  1. Group active memories by key prefix (same as phase1).
 *  2. For each pair of groups, sample 1-2 cross-group candidate pairs
 *     that are semantically related (embedding cosine above a loose
 *     threshold, looser than recall's because we WANT surprises).
 *  3. Batch-feed candidates to an LLM and ask: "what novel connection
 *     (if any) does this pair suggest? output a ProposedFinding only
 *     if the connection is non-obvious."
 *  4. Wrap each finding as a PROPOSE operation. Phase 3 + apply do the
 *     rest; tentative memories land behind the `dream.proposal.` key
 *     prefix so recall excludes them until ratified.
 *
 * What this is NOT:
 *  - Not a duplicate detector (phase1 + bigram handle that).
 *  - Not a knowledge-graph builder (no edges to new entities; we only
 *    propose new memory rows, optional linked via fromMemoryIds for audit).
 *
 * Cost note: this is the most LLM-expensive phase. Bounded by
 * MAX_CANDIDATE_PAIRS per run so a large memory store does not flatten
 * the LLM budget. P2 callers should expect single-digit LLM calls.
 */

import { generateObject } from 'ai';
import { z } from 'zod';

import { generateEmbedding, resolveLanguageModel } from '@/lib/ai';
import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

import type { DreamOperation } from './types';

const logger = createLogger('memory.dream.phase2');

/**
 * Loose cosine similarity threshold for "interesting cross-group pair".
 *
 * Recall uses ~0.2-0.3 (minConfidence default 0.02-0.05 depending on
 * strategy); we go LOWER here (0.15) because Phase 2's whole point is to
 * surface non-obvious connections the user wouldn't have queried for.
 * Too low → noise; too high → only surfaces what recall already finds.
 */
const CROSS_GROUP_SIMILARITY_THRESHOLD = 0.15;

/** Cap on candidate pairs fed to the LLM per run. Bounds LLM cost. */
const MAX_CANDIDATE_PAIRS = 8;

/** Cap on groups inspected, so a user with 50 prefixes doesn't O(n²). */
const MAX_GROUPS = 12;

/** Max memories sampled per group for cross-group pairing. */
const SAMPLE_PER_GROUP = 3;

const recombineSchema = z.object({
  findings: z
    .array(
      z.object({
        content: z
          .string()
          .describe('The novel finding as a canonical statement.'),
        key: z
          .string()
          .describe('Stable dotted key, e.g. "insight.workflow_style".'),
        memoryType: z.enum(['fact', 'preference', 'decision', 'conversation']),
        importance: z.number().int().min(1).max(10),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe(
            'How strongly the pair supports the finding. Below 0.5 = speculative.',
          ),
        rationale: z
          .string()
          .describe('Why this pair suggests the finding (for audit).'),
      }),
    )
    .describe(
      'Empty when the candidate pairs do not support any non-obvious finding.',
    ),
});

export type MemoryRow = {
  id: string;
  userId: string | null;
  projectId: string | null;
  key: string | null;
  content: string;
  memoryType: string;
  importance: number;
};

export function groupByPrefix(memories: MemoryRow[]): Map<string, MemoryRow[]> {
  const groups = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    if (!m.key) continue;
    const dot = m.key.indexOf('.');
    const prefix = dot > 0 ? m.key.slice(0, dot) : m.key;
    const arr = groups.get(prefix) ?? [];
    arr.push(m);
    groups.set(prefix, arr);
  }
  return groups;
}

/**
 * Pick up to SAMPLE_PER_GROUP representative memories from each group
 * (highest importance first). Keeps the cross-group pairing matrix small.
 */
export function sampleGroup(members: MemoryRow[]): MemoryRow[] {
  return [...members]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, SAMPLE_PER_GROUP);
}

/**
 * Naive cosine similarity over two (possibly null) embedding vectors.
 * Returns 0 when either is missing or wrong-dimensional — we then fall
 * back to "no signal" rather than crashing the run.
 */
export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embed a batch of contents, returning a parallel array of vectors
 * (or null when embedding is unavailable). Errors degrade to all-null
 * so the caller falls back to "no cross-group signal, skip Phase 2".
 */
async function embedBatch(
  contents: string[],
  embeddingModel: string | undefined,
  config: AppConfig,
): Promise<(number[] | null)[]> {
  if (!embeddingModel || contents.length === 0) {
    return contents.map(() => null);
  }
  try {
    // generateEmbedding handles single values; batch by calling per-item
    // to avoid coupling to a specific batch API. The contents set is
    // small (≤ MAX_GROUPS * SAMPLE_PER_GROUP), so this is fine.
    const results = await Promise.all(
      contents.map((c) =>
        generateEmbedding(c, embeddingModel, config)
          .then((r) => r.embedding)
          .catch(() => null),
      ),
    );
    return results;
  } catch (error) {
    logger.warn('phase2:embedding_batch_failed', {
      embeddingModel,
      error: error instanceof Error ? error.message : String(error),
    });
    return contents.map(() => null);
  }
}

/**
 * Build the list of cross-group candidate pairs to feed the LLM.
 *
 * Pairs are ranked by embedding cosine; the top MAX_CANDIDATE_PAIRS are
 * kept. Falls back to "no candidates" (→ Phase 2 returns no proposals)
 * when embeddings are unavailable, so the run still completes.
 */
export function selectCandidatePairs(
  groups: Map<string, { memory: MemoryRow; embedding: number[] | null }[]>,
): Array<{ a: MemoryRow; b: MemoryRow; similarity: number }> {
  const prefixes = Array.from(groups.keys()).slice(0, MAX_GROUPS);
  const pairs: Array<{ a: MemoryRow; b: MemoryRow; similarity: number }> = [];

  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      const ga = groups.get(prefixes[i]) ?? [];
      const gb = groups.get(prefixes[j]) ?? [];
      for (const ea of ga) {
        for (const eb of gb) {
          const sim = cosine(ea.embedding, eb.embedding);
          if (sim >= CROSS_GROUP_SIMILARITY_THRESHOLD) {
            pairs.push({ a: ea.memory, b: eb.memory, similarity: sim });
          }
        }
      }
    }
  }

  // Rank by similarity desc, cap to MAX_CANDIDATE_PAIRS.
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs.slice(0, MAX_CANDIDATE_PAIRS);
}

/**
 * Run Phase 2 recombine for one user.
 *
 * Returns PROPOSE operations only — the orchestrator merges them into
 * the same phase3 → apply pipeline as Phase 1's CONSOLIDATE/DELETE.
 */
export async function recombinePhase(input: {
  userId: string;
  config: AppConfig;
}): Promise<{
  operations: DreamOperation[];
  stats: { candidatePairs: number; proposed: number; skipped: boolean };
}> {
  const modelId = input.config.models?.model;
  const embeddingModel = input.config.models?.embedding_model;
  if (!modelId) {
    logger.warn('phase2:no_model');
    return {
      operations: [],
      stats: { candidatePairs: 0, proposed: 0, skipped: true },
    };
  }

  const allMemories = (await listAllLongTermMemoryRows({
    userId: input.userId,
  })) as MemoryRow[];

  const rawGroups = groupByPrefix(allMemories);
  if (rawGroups.size < 2) {
    // Need ≥2 groups to find cross-group connections.
    return {
      operations: [],
      stats: { candidatePairs: 0, proposed: 0, skipped: true },
    };
  }

  // Sample representatives + compute their embeddings.
  const sampled = new Map<string, MemoryRow[]>();
  for (const [prefix, members] of rawGroups) {
    sampled.set(prefix, sampleGroup(members));
  }
  const flatSampled = Array.from(sampled.values()).flat();
  const embeddings = await embedBatch(
    flatSampled.map((m) => m.content),
    embeddingModel,
    input.config,
  );
  const embeddedGroups = new Map<
    string,
    { memory: MemoryRow; embedding: number[] | null }[]
  >();
  let idx = 0;
  for (const [prefix, members] of sampled) {
    embeddedGroups.set(
      prefix,
      members.map((m) => ({ memory: m, embedding: embeddings[idx++] ?? null })),
    );
  }

  const candidates = selectCandidatePairs(embeddedGroups);
  if (candidates.length === 0) {
    // No cross-group signal above threshold (or embeddings unavailable).
    // This is the normal path for a fresh user with little memory.
    return {
      operations: [],
      stats: { candidatePairs: 0, proposed: 0, skipped: false },
    };
  }

  // Build the LLM prompt: show each candidate pair and ask for findings.
  const pairsBlock = candidates
    .map((p, i) => {
      return `Pair ${i + 1} (similarity ${p.similarity.toFixed(2)}):
  A [${p.a.key}] ${p.a.content}
  B [${p.b.key}] ${p.b.content}`;
    })
    .join('\n');

  const prompt = `You are a memory insight engine for a developer-focused AI assistant. Below are pairs of memories from DIFFERENT concept groups that are loosely related (above background similarity but not obvious duplicates). Your job is to spot NON-OBVIOUS connections the consolidator would miss — patterns, preferences, or implicit rules that span multiple domains.

Candidate pairs:
${pairsBlock}

For each pair, decide if it supports a novel finding. A good finding:
- Is a canonical statement (not a question, not a restatement of either source).
- Explains something about the user or their work that NEITHER source says alone.
- Is specific enough to be useful (not "the user likes computers").

If a pair doesn't support a non-obvious finding, skip it. It is fine to return an empty list — quality over quantity. Do not invent findings just because you were given pairs.

For each finding, provide:
- content: the canonical statement (assistant's perspective about "the user" / "the project").
- key: a stable dotted key under "insight.*" (e.g. "insight.workflow_style").
- memoryType: usually "fact" or "preference".
- importance: 1-10 (tentative findings cap at 7).
- confidence: how strongly the pair supports this (typically 0.3-0.6 — these ARE inferences).
- rationale: one sentence on WHY this pair suggests the finding (recorded for audit).`;

  type RecombineResult = z.infer<typeof recombineSchema>;
  let findings: RecombineResult['findings'] = [];
  try {
    const result = await generateObject({
      model: resolveLanguageModel(modelId, input.config),
      schema: recombineSchema,
      schemaName: 'DreamRecombine',
      prompt,
    });
    findings = result.object.findings;
  } catch (error) {
    logger.warn('phase2:llm_failed', {
      userId: input.userId,
      candidatePairs: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      operations: [],
      stats: {
        candidatePairs: candidates.length,
        proposed: 0,
        skipped: false,
      },
    };
  }

  const operations: DreamOperation[] = findings.map((f) => ({
    type: 'PROPOSE',
    content: f.content,
    key: f.key,
    memoryType: f.memoryType,
    importance: f.importance,
    confidence: f.confidence,
    fromMemoryIds: candidates
      .slice(0, 2)
      .flatMap((c) => [c.a.id, c.b.id])
      .slice(0, 4),
    rationale: f.rationale,
  }));

  logger.info('phase2:done', {
    userId: input.userId,
    candidatePairs: candidates.length,
    proposed: operations.length,
  });

  return {
    operations,
    stats: {
      candidatePairs: candidates.length,
      proposed: operations.length,
      skipped: false,
    },
  };
}
