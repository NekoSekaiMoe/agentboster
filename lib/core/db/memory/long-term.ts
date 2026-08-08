import { atomicWriteMode } from '@/lib/core/db/atomic';
import { db, schema } from '@/lib/core/db';
import {
  type HybridSearchRow,
  getHybridCandidateLimit,
  mergeHybridSearchCandidates,
} from '@/lib/memory/search';
import { resolveProjectId } from '@/lib/memory/scope';
import { createLogger } from '@/lib/utils/logger';
import {
  and,
  cosineDistance,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from 'drizzle-orm';

const logger = createLogger('db.memory.long_term');

type LongTermChunkInput = {
  chunkIndex: number;
  content: string;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
};

/** Provenance / trust classes a memory row can carry. */
export type LongTermMemorySourceKind =
  | 'user_asserted'
  | 'assistant_observed'
  | 'tool_observed'
  | 'dream_consolidated'
  | 'dream_recombined';

/**
 * Cap on the stored `recall_query_hashes` list. Each entry is a
 * `yyyymmdd:hash` bucket; the LIST LENGTH is the query-diversity signal
 * Dream consumes, so it only needs to be large enough to discriminate
 * "recalled in many distinct contexts" from "recalled twice". 64 gives
 * headroom far above the boost thresholds (see dream/usage-signals.ts).
 */
export const MAX_RECALL_QUERY_HASHES = 64;

/**
 * Normalize an importance value to the 1–10 scale (default 5). Guards
 * against NaN/Infinity so a malformed client payload can never store an
 * out-of-range or non-finite importance.
 */
function clampImportance(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function buildSearchTextPreview(value?: string) {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? '';

  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117)}...`;
}

function roundScore(value: number) {
  return Number(value.toFixed(4));
}

function summarizeHybridRows(rows: HybridSearchRow[]) {
  return rows.slice(0, 5).map((row) => ({
    chunkId: row.chunkId,
    memoryId: row.memoryId,
    vectorScore: roundScore(row.vectorScore),
    keywordScore: roundScore(row.keywordScore),
    finalScore: roundScore(row.finalScore),
  }));
}

function containsCjk(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(value);
}

/**
 * Build the projectId WHERE condition for recall/list queries.
 *
 * Semantics:
 * - scope undefined / null → no filter (callers that don't care yet;
 *   returns ALL memories, matching pre-project-scoping behavior).
 * - scope = GLOBAL sentinel → only global memories.
 * - scope = a real project id → that project's memories PLUS global ones.
 *   This is the key design decision: when a user is working inside a
 *   project, we never want to hide their global preferences/profile —
 *   that would be a recall regression ("why did the agent forget I like
 *   early-return?"). So project scope is an additive filter, not a
 *   replacement.
 */
function buildProjectScopeCondition(projectIdScope?: string | null) {
  if (projectIdScope === undefined || projectIdScope === null) {
    return undefined;
  }
  const resolved = resolveProjectId(projectIdScope);
  if (resolved === resolveProjectId(null)) {
    // Only global.
    return eq(schema.longTermMemories.projectId, resolved);
  }
  // Project + global.
  return inArray(schema.longTermMemories.projectId, [
    resolved,
    resolveProjectId(null),
  ]);
}

function escapeLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

export async function createLongTermMemoryRow(
  content: string,
  options?: {
    memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
    importance?: number;
    userId?: string;
    key?: string;
    projectId?: string | null;
    dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
    dreamMeta?: Record<string, unknown>;
    sourceKind?: LongTermMemorySourceKind;
    triggerPhrases?: string[];
  },
) {
  // Delegate to the bulk path so both write routes share a single field
  // mapping + default-resolution code path (Repository pattern, AionCore
  // §2). Avoids drift between the single-row and bulk insert shapes.
  const [row] = await createLongTermMemoryRows([
    {
      content,
      memoryType: options?.memoryType,
      importance: options?.importance,
      userId: options?.userId,
      key: options?.key,
      projectId: options?.projectId,
      dreamStatus: options?.dreamStatus,
      dreamMeta: options?.dreamMeta,
      sourceKind: options?.sourceKind,
      triggerPhrases: options?.triggerPhrases,
    },
  ]);
  return row;
}

/**
 * Bulk-insert long-term memory rows. Used by the agentd webhook that
 * receives multiple memories at once (POST /api/agentd/v1/memories) so the
 * route handler doesn't reach into drizzle directly — keeps the DAL the
 * single owner of the longTermMemories table (Repository pattern, AionCore
 * §2). Empty input is a no-op.
 */
export async function createLongTermMemoryRows(
  rows: Array<{
    content: string;
    memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
    importance?: number;
    userId?: string;
    key?: string;
    projectId?: string | null;
    dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
    dreamMeta?: Record<string, unknown>;
    sourceKind?: LongTermMemorySourceKind;
    triggerPhrases?: string[];
  }>,
) {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(schema.longTermMemories)
    .values(
      rows.map((r) => ({
        content: r.content,
        userId: r.userId ?? 'system',
        // Always store the resolved sentinel for global memories — see
        // lib/memory/scope.ts for why NULL is forbidden.
        projectId: resolveProjectId(r.projectId),
        memoryType: r.memoryType ?? 'fact',
        importance: clampImportance(r.importance),
        ...(r.key ? { key: r.key } : {}),
        dreamStatus: r.dreamStatus ?? 'active',
        ...(r.dreamMeta ? { dreamMeta: r.dreamMeta } : {}),
        ...(r.sourceKind ? { sourceKind: r.sourceKind } : {}),
        ...(r.triggerPhrases && r.triggerPhrases.length > 0
          ? { triggerPhrases: r.triggerPhrases }
          : {}),
      })),
    )
    .returning();
  return inserted;
}

/**
 * Upsert a long-term memory by (userId, key).
 *
 * Used by the memory extractor: it always knows the semantic key for a
 * fact (e.g. "user.location", "project.tech_stack") and wants to either
 * create a new row or update the content of an existing one. Manual
 * writes (UI / writeMemory tool) leave key=null and use createLongTermMemoryRow.
 *
 * Behavior:
 * - key is null/empty → falls back to createLongTermMemoryRow (no upsert)
 * - row with matching (userId, key) exists → updates content/type/importance
 * - otherwise → inserts a new row
 *
 * Returns the row and whether it was created (vs updated).
 */
export async function upsertLongTermMemoryByKey(input: {
  userId: string;
  key: string;
  content: string;
  memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
  importance?: number;
  projectId?: string | null;
  /**
   * Dream lifecycle state for the written row. Default 'active'.
   * Pass 'tentative' for Phase 2 proposals so recall excludes them
   * until ratified.
   */
  dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
  /**
   * Optional Dream metadata (confidence / source_kind / provenance).
   * Replaces the row's dream_meta jsonb on update.
   */
  dreamMeta?: Record<string, unknown>;
  /**
   * Provenance / trust class. On update, only applied when explicitly
   * provided — an omitted field preserves the stored class so unrelated
   * content refreshes can't silently reclassify a row.
   */
  sourceKind?: LongTermMemorySourceKind;
  /**
   * Trigger phrases for the lexical prefilter. On update, replaced only
   * when explicitly provided (same preserve-on-omit rule as sourceKind).
   */
  triggerPhrases?: string[];
}): Promise<{
  row: Awaited<ReturnType<typeof createLongTermMemoryRow>>;
  created: boolean;
}> {
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    // Empty key → fall back to createLongTermMemoryRow. Preserve the
    // Dream lifecycle fields (status + meta) so a tentative proposal
    // written under an empty key still lands as tentative, and its
    // provenance survives. Earlier code dropped both fields here.
    const row = await createLongTermMemoryRow(input.content, {
      userId: input.userId,
      memoryType: input.memoryType,
      importance: input.importance,
      projectId: input.projectId,
      dreamStatus: input.dreamStatus,
      dreamMeta: input.dreamMeta,
      sourceKind: input.sourceKind,
      triggerPhrases: input.triggerPhrases,
    });
    return { row, created: true };
  }

  const resolvedProjectId = resolveProjectId(input.projectId);

  const [existing] = await db
    .select({ id: schema.longTermMemories.id })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.projectId, resolvedProjectId),
        eq(schema.longTermMemories.key, trimmedKey),
      ),
    )
    .limit(1);

  if (existing) {
    // Only flip dream_status when the caller EXPLICITLY provided one.
    // Defaulting to 'active' here would silently promote a tentative
    // (or re-activate a superseded) row just because an unrelated
    // content refresh omitted the field. Creation paths still default
    // to 'active' via createLongTermMemoryRow. importance follows the
    // same omission-preserves rule: an update that omits it keeps the
    // stored value (Dream usage adjustments included) instead of
    // resetting it to 5.
    const [row] = await db
      .update(schema.longTermMemories)
      .set({
        content: input.content,
        memoryType: input.memoryType ?? 'fact',
        updatedAt: new Date(),
        ...(input.importance !== undefined
          ? { importance: clampImportance(input.importance) }
          : {}),
        // Conditionally include dream_status only when explicitly provided,
        // so an omitted field preserves the stored status. Spread `false`
        // for the unused branch so the object literal stays a plain object.
        ...(input.dreamStatus !== undefined
          ? { dreamStatus: input.dreamStatus }
          : {}),
        ...(input.dreamMeta ? { dreamMeta: input.dreamMeta } : {}),
        ...(input.sourceKind !== undefined
          ? { sourceKind: input.sourceKind }
          : {}),
        ...(input.triggerPhrases !== undefined
          ? { triggerPhrases: input.triggerPhrases }
          : {}),
      })
      .where(eq(schema.longTermMemories.id, existing.id))
      .returning();
    return { row, created: false };
  }

  const row = await createLongTermMemoryRow(input.content, {
    userId: input.userId,
    memoryType: input.memoryType,
    importance: input.importance,
    key: trimmedKey,
    projectId: input.projectId,
    dreamStatus: input.dreamStatus,
    dreamMeta: input.dreamMeta,
    sourceKind: input.sourceKind,
    triggerPhrases: input.triggerPhrases,
  });
  return { row, created: true };
}

// TODO(tech-debt): isolation test gap.
//
// These three helpers take `options.userId?` OPTIONAL and only add the
// `WHERE userId = ?` predicate when it's passed. That's by design for the
// builtin/system memory paths (which read cross-user) but means a future
// caller in the agentd plane that forgets the option silently degrades to
// global scope — reintroducing the cross-user leak commit 8762ba3 closed.
//
// Why this isn't covered by a regression test like
// vault.isolation.test.ts: the functions import the production db
// singleton, which can't be swapped to PGlite without either dependency
// injection (Repository refactor) or vi.mock — and the schema constraint
// on long_term_memories.user_id has a `default 'system'` (so 'system'
// is a valid non-null value) which means a pure schema-level isolation
// test wouldn't meaningfully exercise the DAL's WHERE-clause scoping. The
// pglite-harness.ts docstring calls this out as needing the Repository
// refactor before these DAL functions become integration-testable.
//
// Mitigation today: every agentd route that reaches these functions goes
// through resolveAgentdResourceAccess() (lib/core/db/agentd.ts) which
// derives the owner server-side; a caller that forgets to thread the
// resolved userId here would still have had to derive it correctly
// upstream. The risk is a future refactor that adds a new call site
// bypassing the helper — code review is the current guard, not CI.
//
// When the Repository refactor lands, harden: (1) make userId REQUIRED on
// these three functions (split the builtin/system path into a separate
// `_withoutUserScope` variant); (2) add a PGlite isolation test like
// vault.isolation.test.ts proving user A's rows aren't reachable from
// user B's get/update/delete.
export async function getLongTermMemoryRow(
  id: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .select()
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

export async function listLongTermMemoryRows(options?: {
  limit?: number;
  offset?: number;
  userId?: string;
  projectIdScope?: string | null;
  /**
   * When true, include tentative/superseded/contradicted rows. Default
   * false so recall + UI only see active memories. Dream is the main
   * caller that passes true (it needs the full set to consolidate).
   */
  includeInactive?: boolean;
}) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 100, 200));
  const safeOffset = Math.max(0, options?.offset ?? 0);

  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }
  const scopeCondition = buildProjectScopeCondition(options?.projectIdScope);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }
  if (!options?.includeInactive) {
    conditions.push(eq(schema.longTermMemories.dreamStatus, 'active'));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt))
    .limit(safeLimit)
    .offset(safeOffset);
}

export async function listAllLongTermMemoryRows(options?: {
  userId?: string;
  projectIdScope?: string | null;
  /**
   * When true, include tentative/superseded/contradicted rows. Default
   * false. Dream phase1/2 pass false (they consolidate active rows
   * only); admin / audit callers pass true to see the full lifecycle.
   */
  includeInactive?: boolean;
}) {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }
  const scopeCondition = buildProjectScopeCondition(options?.projectIdScope);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }
  if (!options?.includeInactive) {
    conditions.push(eq(schema.longTermMemories.dreamStatus, 'active'));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt));
}

/**
 * List distinct userIds that own long-term memories. Used by the Dream
 * orchestrator's nightly fan-out: it needs to run once per user that has
 * memories to consolidate, without pulling a full table scan into JS.
 *
 * Excludes the 'system' sentinel user — Dream is a per-developer feature
 * and 'system' rows are shared/global facts that don't belong to a single
 * user's consolidation pass.
 */
export async function listDistinctLongTermMemoryUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: schema.longTermMemories.userId })
    .from(schema.longTermMemories)
    .where(
      and(
        isNotNull(schema.longTermMemories.userId),
        ne(schema.longTermMemories.userId, 'system'),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}

export async function countLongTermMemoriesByUserIds(userIds: string[]) {
  const ids = [...new Set(userIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) {
    return new Map<string, number>();
  }

  const rows = await db
    .select({
      userId: schema.longTermMemories.userId,
      count: count(),
    })
    .from(schema.longTermMemories)
    .where(inArray(schema.longTermMemories.userId, ids))
    .groupBy(schema.longTermMemories.userId);

  return new Map(
    rows
      .filter((row): row is { userId: string; count: number } =>
        Boolean(row.userId),
      )
      .map((row) => [row.userId, Number(row.count)]),
  );
}

export async function updateLongTermMemoryRow(
  id: string,
  content: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .update(schema.longTermMemories)
    .set({ content, updatedAt: new Date() })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

export async function deleteLongTermMemoryRow(
  id: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .delete(schema.longTermMemories)
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Atomically delete a TENTATIVE Dream proposal owned by the user.
 * Matching id + userId + dream_status in one DELETE closes the TOCTOU
 * window of check-then-delete flows (a concurrent ratification between
 * the check and the delete would otherwise remove an ACTIVE memory).
 * Returns the deleted row, or null when no tentative row matched.
 */
export async function deleteTentativeMemoryRow(
  id: string,
  options: { userId: string },
) {
  const [row] = await db
    .delete(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.id, id),
        eq(schema.longTermMemories.userId, options.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * Delete a long-term memory row by (userId, key).
 *
 * Used by the memory extractor's DELETE action: when the LLM decides a
 * previously-stored fact is wrong/outdated, it emits the existing key
 * with action=DELETE. Returns the deleted row (or null if no match).
 */
export async function deleteLongTermMemoryByKey(input: {
  userId: string;
  key: string;
  projectId?: string | null;
}) {
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    return null;
  }

  const [row] = await db
    .delete(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(
          schema.longTermMemories.projectId,
          resolveProjectId(input.projectId),
        ),
        eq(schema.longTermMemories.key, trimmedKey),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * Adjust a memory's importance in place (Dream usage-feedback op).
 * Records the adjustment reason + run id in dream_meta so the audit
 * trail shows WHY importance moved. Returns the updated row, or null
 * when the id doesn't exist / belongs to another user.
 */
export async function adjustLongTermMemoryImportance(input: {
  id: string;
  userId?: string;
  importance: number;
  reason: 'frequently_recalled' | 'never_recalled';
  dreamRunId?: string;
}) {
  const conditions = [eq(schema.longTermMemories.id, input.id)];
  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  const clamped = Math.max(1, Math.min(10, Math.round(input.importance)));

  const [existing] = await db
    .select({ dreamMeta: schema.longTermMemories.dreamMeta })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);
  if (!existing) return null;
  const prevMeta = (existing.dreamMeta as Record<string, unknown> | null) ?? {};

  const [row] = await db
    .update(schema.longTermMemories)
    .set({
      importance: clamped,
      updatedAt: new Date(),
      dreamMeta: {
        ...prevMeta,
        lastImportanceAdjustment: {
          importance: clamped,
          reason: input.reason,
          ...(input.dreamRunId ? { dreamRunId: input.dreamRunId } : {}),
          at: new Date().toISOString(),
        },
        lastDreamAt: new Date().toISOString(),
      },
    })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Read rows about to be hard-deleted so the Dream run audit keeps a
 * pre-image (OpenClaw stores rewrite preimages before an accepted
 * rewrite). Content is truncated to keep the dream_runs payload small.
 */
export async function getLongTermMemoryPreimages(
  ids: string[],
  userId: string,
  options?: { maxContentChars?: number },
) {
  if (ids.length === 0) return [];
  const maxContentChars = options?.maxContentChars ?? 500;

  const rows = await db
    .select({
      id: schema.longTermMemories.id,
      key: schema.longTermMemories.key,
      content: schema.longTermMemories.content,
      memoryType: schema.longTermMemories.memoryType,
      importance: schema.longTermMemories.importance,
      projectId: schema.longTermMemories.projectId,
    })
    .from(schema.longTermMemories)
    .where(
      and(
        inArray(schema.longTermMemories.id, ids),
        eq(schema.longTermMemories.userId, userId),
      ),
    );

  return rows.map((row) => ({
    ...row,
    content:
      row.content.length > maxContentChars
        ? `${row.content.slice(0, maxContentChars)}…`
        : row.content,
  }));
}

/**
 * Mark a memory as superseded by a newer canonical fact, without deleting
 * it. Used by Dream Phase 1 consolidation (CONSOLIDATE op) and by direct
 * SUPERSEDE ops — replaces the old delete-based behavior so the audit
 * trail (original content + when it was retired) survives for review.
 *
 * The optional `supersededBy` id is recorded in `dream_meta.provenance`
 * so a reviewer can trace from a retired memory forward to its
 * replacement. Recall excludes superseded rows via the partial index on
 * `dream_status = 'active'`.
 *
 * Returns the updated row (or null if the id doesn't exist / belongs to
 * another user).
 */
export async function markLongTermMemorySuperseded(input: {
  id: string;
  userId?: string;
  /**
   * Optional id of the memory that replaces this one. Recorded as
   * provenance for forward-tracing.
   */
  supersededBy?: string;
  /**
   * Optional Dream run id that triggered the supersede, for audit.
   */
  dreamRunId?: string;
}) {
  const conditions = [eq(schema.longTermMemories.id, input.id)];
  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  // Read the current row first so we can DEEP-MERGE provenance into the
  // existing dream_meta rather than overwriting the whole column. Earlier
  // code did `dreamMeta: { provenance: {...}, lastDreamAt }` which wiped
  // any previously-recorded confidence / sourceKind / earlier provenance.
  const [existing] = await db
    .select({ dreamMeta: schema.longTermMemories.dreamMeta })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);
  const prevMeta =
    (existing?.dreamMeta as Record<string, unknown> | null) ?? {};
  const prevProvenance =
    (prevMeta.provenance as Record<string, unknown> | undefined) ?? {};

  const [row] = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: 'superseded',
      updatedAt: new Date(),
      dreamMeta: {
        ...prevMeta,
        provenance: {
          ...prevProvenance,
          ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
          ...(input.dreamRunId ? { dreamRunId: input.dreamRunId } : {}),
        },
        lastDreamAt: new Date().toISOString(),
      },
    })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Promote a tentative Dream proposal to active so it joins recall.
 *
 * Called by the ratification pass (auto or manual): Dream Phase 2 writes
 * proposals with dream_status='tentative'; this flips them to 'active'
 * once ratified. Optionally down-ranks (demote to 'contradicted') when
 * a reviewer rejects the proposal — `rejected=true` records the rejection
 * in dream_meta without deleting the row (so the proposal isn't
 * re-proposed next run).
 */
export async function ratifyLongTermMemory(input: {
  id: string;
  userId?: string;
  /**
   * true = ratify (tentative → active). false = reject (tentative →
   * contradicted, recorded so Dream won't re-propose the same finding).
   */
  ratified: boolean;
  /**
   * Optional reviewer note recorded in dream_meta for audit.
   */
  note?: string;
}) {
  const conditions = [
    eq(schema.longTermMemories.id, input.id),
    eq(schema.longTermMemories.dreamStatus, 'tentative'),
  ];
  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  // Read the current row so we can merge into the existing dream_meta
  // (preserving confidence / sourceKind / provenance from the original
  // proposal) instead of overwriting it with just the ratification fields.
  const [existing] = await db
    .select({ dreamMeta: schema.longTermMemories.dreamMeta })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);
  const prevMeta =
    (existing?.dreamMeta as Record<string, unknown> | null) ?? {};

  const [row] = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: input.ratified ? 'active' : 'contradicted',
      updatedAt: new Date(),
      dreamMeta: {
        ...prevMeta,
        ratifiedAt: new Date().toISOString(),
        ratified: input.ratified,
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Bulk-set the dream_status of ALL of a user's tentative proposals in one
 * UPDATE — used by the ratify-all / reject-all handler so a 50-proposal
 * review queue is one round-trip, not 50.
 *
 * Scoped to (userId, dream_status='tentative') so it can only promote/demote
 * pending proposals, never touch active/superseded rows. Merges the
 * ratification fields into existing dream_meta at the SQL level (jsonb ||).
 *
 * @returns the number of rows actually updated (0 if none were tentative).
 */
export async function bulkSetTentativeStatus(input: {
  userId: string;
  /** true → promote to 'active'; false → demote to 'contradicted'. */
  ratified: boolean;
}): Promise<number> {
  const updated = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: input.ratified ? 'active' : 'contradicted',
      updatedAt: new Date(),
      // Merge ratification fields into whatever dream_meta each row already
      // carries — coalesce to '{}' so legacy rows (null meta) aren't nulled
      // out. jsonb || merges top-level keys per row.
      dreamMeta: sql`coalesce(${schema.longTermMemories.dreamMeta}, '{}'::jsonb) || ${JSON.stringify(
        {
          ratifiedAt: new Date().toISOString(),
          ratified: input.ratified,
        },
      )}::jsonb`,
    })
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .returning({ id: schema.longTermMemories.id });
  return updated.length;
}
export async function listTentativeMemories(input: {
  userId: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return db
    .select()
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .orderBy(desc(schema.longTermMemories.updatedAt))
    .limit(limit);
}

/**
 * List distinct userIds that own tentative Dream proposals. Used by
 * the auto-ratify cron to fan out across users without scanning every
 * row in JS. Symmetric to listDistinctLongTermMemoryUserIds but
 * filtered to dream_status='tentative' so we only touch users who
 * actually have proposals pending review.
 */
export async function listDistinctTentativeUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: schema.longTermMemories.userId })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
        isNotNull(schema.longTermMemories.userId),
        ne(schema.longTermMemories.userId, 'system'),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}

export async function replaceLongTermMemoryChunks(
  memoryId: string,
  chunks: LongTermChunkInput[],
) {
  if (chunks.length === 0) {
    return;
  }

  logger.info('replace_chunks:start', {
    memoryId,
    chunkCount: chunks.length,
    embeddedChunkCount: chunks.filter(
      (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0,
    ).length,
    embeddingModels: [...new Set(chunks.map((chunk) => chunk.embeddingModel))],
    embeddingDimensions: [
      ...new Set(chunks.map((chunk) => chunk.embeddingDimensions ?? null)),
    ],
  });

  // Delete-then-reinsert atomically. The two drivers behind the `db`
  // singleton have non-overlapping atomic primitives — neon-http exposes
  // db.batch, node-postgres exposes db.transaction — so branch on
  // atomicWriteMode(). The delete + insert have no inter-query dependency.
  const deleteChunks = db
    .delete(schema.longTermMemoryChunks)
    .where(eq(schema.longTermMemoryChunks.memoryId, memoryId));
  const insertChunks = db.insert(schema.longTermMemoryChunks).values(
    chunks.map((chunk) => ({
      memoryId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      embedding: chunk.embedding ?? null,
      embeddingModel: chunk.embeddingModel ?? null,
      embeddingDimensions:
        chunk.embeddingDimensions ?? chunk.embedding?.length ?? null,
      tsv: sql`to_tsvector('simple', ${chunk.content})`,
    })),
  );
  if (atomicWriteMode() === 'neon') {
    await db.batch([deleteChunks, insertChunks]);
  } else {
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.longTermMemoryChunks)
        .where(eq(schema.longTermMemoryChunks.memoryId, memoryId));
      await tx.insert(schema.longTermMemoryChunks).values(
        chunks.map((chunk) => ({
          memoryId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          embedding: chunk.embedding ?? null,
          embeddingModel: chunk.embeddingModel ?? null,
          embeddingDimensions:
            chunk.embeddingDimensions ?? chunk.embedding?.length ?? null,
          tsv: sql`to_tsvector('simple', ${chunk.content})`,
        })),
      );
    });
  }

  logger.info('replace_chunks:success', {
    memoryId,
    chunkCount: chunks.length,
  });
}

export async function listLongTermMemoryChunksForMemory(memoryId: string) {
  return db
    .select()
    .from(schema.longTermMemoryChunks)
    .where(eq(schema.longTermMemoryChunks.memoryId, memoryId))
    .orderBy(schema.longTermMemoryChunks.chunkIndex);
}

async function listKeywordCandidateRows(options: {
  searchText: string;
  candidateLimit: number;
  userId?: string;
  projectIdScope?: string | null;
}) {
  const normalizedSearchText = options.searchText.trim();
  const likePattern = `%${escapeLikePattern(normalizedSearchText)}%`;
  const useSubstringFallback = containsCjk(normalizedSearchText);
  const { userId } = options;

  const userIdCondition = userId
    ? eq(schema.longTermMemories.userId, userId)
    : undefined;
  const scopeCondition = buildProjectScopeCondition(options.projectIdScope);
  // Recall excludes non-active Dream rows (tentative proposals +
  // superseded sources + contradicted). Because recall is always
  // per-user, needsJoin is always true in practice — but we defensively
  // force the join when this condition is present so the filter can't
  // be silently dropped on a future caller that passes neither userId
  // nor scope.
  const activeStatusCondition = eq(
    schema.longTermMemories.dreamStatus,
    'active',
  );
  // projectId scope lives on long_term_memories, so any scope filter forces
  // the join even when the caller didn't pass a userId (otherwise the
  // un-joined query would silently ignore the scope and leak cross-project
  // memories into recall).
  const needsJoin =
    Boolean(userId) ||
    Boolean(scopeCondition) ||
    Boolean(activeStatusCondition);

  const baseSelect = {
    chunkId: schema.longTermMemoryChunks.id,
    memoryId: schema.longTermMemoryChunks.memoryId,
    content: schema.longTermMemoryChunks.content,
  };

  const tsQueryExpr = sql`websearch_to_tsquery('simple', ${normalizedSearchText})`;
  const keywordScoreExpr = sql<number>`coalesce(ts_rank(${schema.longTermMemoryChunks.tsv}, ${tsQueryExpr}, 32), 0)`;
  const substringScoreExpr = sql<number>`case when ${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\' then 1 else 0 end`;

  const joinMemories = <T extends Parameters<typeof db.select>[0]>(
    selectCols: T,
  ) => {
    const base = db.select(selectCols).from(schema.longTermMemoryChunks);
    return needsJoin
      ? base.innerJoin(
          schema.longTermMemories,
          eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
        )
      : base;
  };

  if (useSubstringFallback) {
    return joinMemories({ ...baseSelect, keywordScore: substringScoreExpr })
      .where(
        and(
          sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
          userIdCondition,
          scopeCondition,
          activeStatusCondition,
        ),
      )
      .orderBy(
        sql`${substringScoreExpr} DESC`,
        desc(schema.longTermMemoryChunks.createdAt),
      )
      .limit(options.candidateLimit);
  }

  const mainRows = await joinMemories({
    ...baseSelect,
    keywordScore: keywordScoreExpr,
  })
    .where(
      and(
        sql`${schema.longTermMemoryChunks.tsv} @@ ${tsQueryExpr}`,
        userIdCondition,
        scopeCondition,
        activeStatusCondition,
      ),
    )
    .orderBy(sql`${keywordScoreExpr} DESC`)
    .limit(options.candidateLimit);

  if (mainRows.length > 0) {
    return mainRows;
  }

  return joinMemories({ ...baseSelect, keywordScore: substringScoreExpr })
    .where(
      and(
        sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
        userIdCondition,
        scopeCondition,
        activeStatusCondition,
      ),
    )
    .orderBy(
      sql`${substringScoreExpr} DESC`,
      desc(schema.longTermMemoryChunks.createdAt),
    )
    .limit(options.candidateLimit);
}

export async function hybridSearchLongTermMemoryChunks(options: {
  queryEmbedding?: number[];
  queryEmbeddingModel?: string;
  queryEmbeddingDimensions?: number;
  searchText?: string;
  minConfidence: number;
  limit: number;
  offset: number;
  userId?: string;
  projectIdScope?: string | null;
}): Promise<HybridSearchRow[]> {
  const {
    queryEmbedding,
    queryEmbeddingModel,
    queryEmbeddingDimensions,
    searchText,
    minConfidence,
    limit,
    offset,
    userId,
    projectIdScope,
  } = options;

  const hasEmbedding = queryEmbedding && queryEmbedding.length > 0;
  const vectorDimensions = queryEmbeddingDimensions ?? queryEmbedding?.length;
  const canRunVectorSearch =
    hasEmbedding &&
    typeof queryEmbeddingModel === 'string' &&
    queryEmbeddingModel.length > 0 &&
    typeof vectorDimensions === 'number';
  const normalizedSearchText = searchText?.trim() || '';
  const hasTextSearch = normalizedSearchText.length > 0;
  const candidateLimit = getHybridCandidateLimit({ limit, offset });

  logger.info('hybrid_search:start', {
    hasEmbedding,
    hasTextSearch,
    searchTextPreview: buildSearchTextPreview(normalizedSearchText),
    queryEmbeddingModel: queryEmbeddingModel ?? null,
    queryEmbeddingDimensions: vectorDimensions ?? null,
    minConfidence,
    limit,
    offset,
    candidateLimit,
  });

  if (!hasEmbedding && !hasTextSearch) {
    logger.info('hybrid_search:empty_input');
    return [];
  }

  if (!hasEmbedding && hasTextSearch) {
    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:keyword_only', {
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  if (!canRunVectorSearch) {
    if (!hasTextSearch) {
      return [];
    }

    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:fallback_keyword_only', {
      reason: 'vector_search_not_available',
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const activeQueryEmbedding = queryEmbedding;
  const activeEmbeddingModel = queryEmbeddingModel;
  const activeVectorDimensions = vectorDimensions;

  if (
    !activeQueryEmbedding ||
    activeQueryEmbedding.length === 0 ||
    typeof activeEmbeddingModel !== 'string' ||
    activeEmbeddingModel.length === 0 ||
    typeof activeVectorDimensions !== 'number'
  ) {
    if (!hasTextSearch) {
      return [];
    }

    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.warn('hybrid_search:fallback_keyword_only', {
      reason: 'vector_inputs_incomplete_after_guard',
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const distanceExpr = cosineDistance(
    schema.longTermMemoryChunks.embedding,
    activeQueryEmbedding,
  );
  const vectorScoreExpr = sql<number>`greatest(0, 1 - (${distanceExpr}))`;
  const vectorRows = await db
    .select({
      chunkId: schema.longTermMemoryChunks.id,
      memoryId: schema.longTermMemoryChunks.memoryId,
      content: schema.longTermMemoryChunks.content,
      vectorScore: vectorScoreExpr,
      importance: schema.longTermMemories.importance,
      lastAccessedAt: schema.longTermMemoryChunks.lastAccessedAt,
    })
    .from(schema.longTermMemoryChunks)
    .innerJoin(
      schema.longTermMemories,
      eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
    )
    .where(
      and(
        sql`${schema.longTermMemoryChunks.embedding} IS NOT NULL`,
        eq(schema.longTermMemoryChunks.embeddingModel, activeEmbeddingModel),
        eq(
          schema.longTermMemoryChunks.embeddingDimensions,
          activeVectorDimensions,
        ),
        userId ? eq(schema.longTermMemories.userId, userId) : undefined,
        buildProjectScopeCondition(projectIdScope),
        eq(schema.longTermMemories.dreamStatus, 'active'),
      ),
    )
    .orderBy(sql`${vectorScoreExpr} DESC`)
    .limit(candidateLimit);

  logger.info('hybrid_search:vector_candidates', {
    queryEmbeddingModel: activeEmbeddingModel,
    queryEmbeddingDimensions: activeVectorDimensions,
    vectorCandidateCount: vectorRows.length,
    topVectorCandidates: vectorRows.slice(0, 5).map((row) => ({
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      vectorScore: roundScore(row.vectorScore),
    })),
  });

  if (!hasTextSearch) {
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows,
      keywordRows: [],
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:vector_only', {
      vectorCandidateCount: vectorRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const keywordRows = await listKeywordCandidateRows({
    searchText: normalizedSearchText,
    candidateLimit,
    userId,
    projectIdScope,
  });

  logger.info('hybrid_search:keyword_candidates', {
    keywordCandidateCount: keywordRows.length,
    topKeywordCandidates: keywordRows.slice(0, 5).map((row) => ({
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      keywordScore: roundScore(row.keywordScore),
    })),
  });

  const mergedRows = mergeHybridSearchCandidates({
    vectorRows,
    keywordRows,
    minConfidence,
    limit,
    offset,
  });

  logger.info(
    vectorRows.length === 0
      ? 'hybrid_search:hybrid_no_vector_hits'
      : 'hybrid_search:hybrid_result',
    {
      vectorCandidateCount: vectorRows.length,
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    },
  );

  return mergedRows;
}

/**
 * Fetch lightweight metadata (sourceKind / importance) for a set of
 * memory ids in one query. Used by the recall path to attach taint
 * framing + usage signals onto already-ranked results without
 * re-running search.
 */
export async function getMemoryMetaByIds(
  memoryIds: string[],
  userId: string,
): Promise<
  Map<
    string,
    {
      sourceKind: LongTermMemorySourceKind;
      importance: number;
    }
  >
> {
  if (memoryIds.length === 0 || !userId) return new Map();

  const rows = await db
    .select({
      id: schema.longTermMemories.id,
      sourceKind: schema.longTermMemories.sourceKind,
      importance: schema.longTermMemories.importance,
    })
    .from(schema.longTermMemories)
    .where(
      and(
        inArray(schema.longTermMemories.id, memoryIds),
        eq(schema.longTermMemories.userId, userId),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.id,
      { sourceKind: row.sourceKind, importance: row.importance },
    ]),
  );
}

export async function updateLastAccessedAt(chunkIds: string[]) {
  if (chunkIds.length === 0) {
    return;
  }

  await db
    .update(schema.longTermMemoryChunks)
    .set({ lastAccessedAt: new Date() })
    .where(inArray(schema.longTermMemoryChunks.id, chunkIds));
}

/**
 * Record recall usage for a batch of memories (OpenClaw-style usage
 * feedback: "memory graduates because it kept being useful").
 *
 * For each hit: recall_count += 1, last_recalled_at = now, and the
 * `yyyymmdd:queryHash` bucket is appended to recall_query_hashes
 * (deduped, capped at MAX_RECALL_QUERY_HASHES) so Dream can measure
 * query diversity without storing raw query text.
 *
 * Atomic single-statement update per row: dedupe/append/truncate of the
 * `dayBucket:queryHash` bucket happens inside one UPDATE JSONB
 * expression, and ownership (userId) is enforced in the same statement's
 * WHERE clause — no read-then-write race, no cross-user writes. Hits are
 * deduplicated by memoryId first so one turn records at most one usage
 * signal per memory. Best-effort — individual row failures are logged
 * and skipped, never thrown.
 */
export async function recordRecallHits(input: {
  userId: string;
  hits: Array<{ memoryId: string; queryHash: string }>;
}) {
  const { userId, hits } = input;
  if (hits.length === 0) return;

  const dayBucket = new Date().toISOString().slice(0, 10).replaceAll('-', '');

  // One usage signal per unique memory per turn.
  const uniqueHits = new Map<string, string>();
  for (const hit of hits) {
    if (!uniqueHits.has(hit.memoryId)) {
      uniqueHits.set(hit.memoryId, hit.queryHash);
    }
  }

  for (const [memoryId, queryHash] of uniqueHits) {
    const bucket = `${dayBucket}:${queryHash}`;
    try {
      await db
        .update(schema.longTermMemories)
        .set({
          recallCount: sql`${schema.longTermMemories.recallCount} + 1`,
          lastRecalledAt: new Date(),
          // Dedupe (drop any existing copy of today's bucket), append it
          // at the tail, then keep only the last MAX_RECALL_QUERY_HASHES
          // entries — all inside Postgres, no preliminary SELECT.
          recallQueryHashes: sql`(
            SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
            FROM (
              SELECT elem, ord
              FROM (
                SELECT elem, ord,
                       ROW_NUMBER() OVER (ORDER BY ord) AS rn,
                       COUNT(*) OVER () AS total
                FROM (
                  SELECT value AS elem, ord
                  FROM jsonb_array_elements_text(${schema.longTermMemories.recallQueryHashes}) WITH ORDINALITY AS e(value, ord)
                  WHERE value <> ${bucket}
                  UNION ALL
                  SELECT ${bucket} AS elem, ${Number.MAX_SAFE_INTEGER} AS ord
                ) combined
              ) numbered
              WHERE rn > total - ${MAX_RECALL_QUERY_HASHES}
            ) kept
          )`,
        })
        .where(
          and(
            eq(schema.longTermMemories.id, memoryId),
            eq(schema.longTermMemories.userId, userId),
          ),
        );
    } catch (error) {
      logger.warn('record_recall_hits:row_failed', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * List active memories that carry trigger phrases, for the per-turn
 * lexical prefilter (lib/memory/triggers.ts). Returns only the columns
 * the matcher needs so the per-turn payload stays small.
 */
export async function listTriggerPhraseRows(options: {
  userId: string;
  projectIdScope?: string | null;
  limit?: number;
}) {
  const safeLimit = Math.max(1, Math.min(options.limit ?? 500, 1000));

  const conditions = [
    eq(schema.longTermMemories.userId, options.userId),
    eq(schema.longTermMemories.dreamStatus, 'active'),
    isNotNull(schema.longTermMemories.triggerPhrases),
  ];
  const scopeCondition = buildProjectScopeCondition(options.projectIdScope);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }

  const rows = await db
    .select({
      id: schema.longTermMemories.id,
      content: schema.longTermMemories.content,
      sourceKind: schema.longTermMemories.sourceKind,
      importance: schema.longTermMemories.importance,
      triggerPhrases: schema.longTermMemories.triggerPhrases,
    })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .orderBy(desc(schema.longTermMemories.importance))
    .limit(safeLimit);

  // Defense in depth: rows with an empty array stored (writers guard
  // against this, but a manual UPDATE could still produce one) are
  // useless to the matcher — filter them out here.
  return rows.filter(
    (row) => Array.isArray(row.triggerPhrases) && row.triggerPhrases.length > 0,
  );
}

/**
 * Update a TENTATIVE Dream proposal's editable fields (content /
 * importance / trigger phrases). Restricted to dream_status='tentative'
 * rows owned by the user so the review UI can never mutate an active,
 * superseded, or contradicted memory through this path. Returns the
 * updated row, or null when the id isn't a pending proposal.
 */
export async function updateTentativeMemoryRow(input: {
  id: string;
  userId: string;
  content?: string;
  importance?: number;
  triggerPhrases?: string[];
}) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof input.content === 'string' && input.content.trim().length > 0) {
    set.content = input.content.trim();
  }
  if (typeof input.importance === 'number') {
    set.importance = Math.max(1, Math.min(10, Math.round(input.importance)));
  }
  if (input.triggerPhrases !== undefined) {
    set.triggerPhrases = input.triggerPhrases;
  }
  if (Object.keys(set).length === 1) {
    // Only updatedAt — nothing to change.
    return null;
  }

  const [row] = await db
    .update(schema.longTermMemories)
    .set(set)
    .where(
      and(
        eq(schema.longTermMemories.id, input.id),
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .returning();

  return row ?? null;
}
