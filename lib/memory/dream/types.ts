/**
 * Dream system types — inspired by AutoGPT's three-phase offline memory
 * consolidation pipeline (ref/autogpt_platform/backend/backend/copilot/dream/).
 *
 * Phase 1 — Consolidation: cluster recent episodic memories into canonical
 *           facts with provenance. Extends the existing compact.ts by
 *           tracking WHERE consolidated facts came from.
 * Phase 2 — Recombination: discover cross-cluster connections, propose
 *           novel findings as `tentative` (requires ratification).
 * Phase 3 — Sanitize:      near-duplicate detection + safety filtering
 *           before applying operations.
 * Apply  — write the surviving operations back to long_term_memories +
 *           memory_edges, marking superseded sources.
 *
 * agentboster adaptation notes:
 * - AutoGPT stores status/confidence on Graphiti edge properties; we store
 *   them on the `long_term_memories` row via the `dream_meta` jsonb column
 *   (added in a migration) — no graph DB dependency.
 * - Provenance is a list of source memory IDs + the dream run id, so a
 *   reviewer or future audit can see WHY a fact exists.
 */

/**
 * Lifecycle state of a memory.
 *
 * - `active`:      normal recalled memory, contributes to recall + profile.
 * - `tentative`:   proposed by a Dream recombine pass, NOT yet ratified.
 *                  Excluded from recall until promoted (ratification pass)
 *                  or demoted (deleted). Mirrors AutoGPT's Phase 2 semantics.
 * - `superseded`:  replaced by a newer consolidated fact. Kept for audit
 *                  (provenance) but excluded from recall.
 * - `contradicted`: flagged as wrong by a later observation. Kept for audit.
 */
export type MemoryStatus =
  | 'active'
  | 'tentative'
  | 'superseded'
  | 'contradicted';

/**
 * Where a memory fact originated.
 *
 * - `user_asserted`:     the user stated it directly.
 * - `assistant_observed`: inferred by the assistant during a session.
 * - `tool_observed`:     produced by a tool (file read, web fetch, etc.).
 * - `dream_consolidated`:created by Dream Phase 1 (merge of episodes).
 * - `dream_recombined`:  created by Dream Phase 2 (novel connection).
 */
export type SourceKind =
  | 'user_asserted'
  | 'assistant_observed'
  | 'tool_observed'
  | 'dream_consolidated'
  | 'dream_recombined';

/**
 * Per-memory Dream metadata, stored in `long_term_memories.dream_meta`.
 *
 * Kept as a jsonb column rather than top-level fields so existing recall
 * queries, indexes, and the project-scoped uniqueness rule do not need to
 * change. Fields are optional so legacy rows (pre-Dream) keep working —
 * they are treated as `status='active'` with no provenance.
 */
export interface DreamMeta {
  /**
   * Lifecycle state. **Authoritative source is the `dream_status`
   * column**; this field is retained ONLY for legacy compatibility with
   * rows written before the column existed. New code must read/filter on
   * `dream_status`, not `meta.status`. Missing = active (back-compat).
   */
  status?: MemoryStatus;
  /** Confidence in [0, 1] from the Dream model. Missing = unspecified. */
  confidence?: number;
  /** Origin of the fact. Missing = treat as user_asserted for display. */
  sourceKind?: SourceKind;
  /**
   * Provenance — source memory IDs that produced this fact, plus the
   * dream run id that created/updated it. Empty for non-dream facts.
   * Stored as a stable list so an audit can trace any fact back to its
   * source episodes even after the originals are superseded.
   */
  provenance?: {
    sourceMemoryIds: string[];
    dreamRunId?: string;
    /**
     * For SUPERSEDE-only: id of the canonical fact that retired this row.
     * Populated by markLongTermMemorySuperseded; forward-traces a
     * superseded memory to its replacement.
     */
    supersededBy?: string;
  };
  /**
   * Human-readable rationale for PROPOSE rows — why the recombine pass
   * thought this finding was worth proposing. Written by apply.ts, read
   * by the review UI so a reviewer sees the model's reasoning.
   */
  rationale?: string;
  /** Last time Dream touched this row (ISO string). */
  lastDreamAt?: string;
}

/**
 * One operation proposed by a Dream phase, to be applied to the store.
 *
 * Mirrors AutoGPT's `DreamOperation` but adapted to agentboster's
 * (userId, projectId, key) addressing: we upsert by key within a scope
 * rather than by Graphiti edge uuid.
 */
export type DreamOperation =
  | {
      type: 'CONSOLIDATE';
      /** IDs of the source memories being merged into this canonical fact. */
      sourceMemoryIds: string[];
      /** Stable key for the merged memory (within userId + projectId scope). */
      mergedKey: string;
      /** Project scope; defaults to GLOBAL_PROJECT_ID when absent. */
      projectId?: string;
      mergedContent: string;
      mergedType: 'fact' | 'preference' | 'decision' | 'conversation';
      mergedImportance: number;
      confidence: number;
    }
  | {
      type: 'DELETE';
      memoryIds: string[];
      /** Why the phase decided to delete — recorded in logs, not the DB. */
      reason?: string;
    }
  | {
      type: 'PROPOSE';
      /**
       * Phase 2 only. Creates a new `tentative` memory + an edge linking
       * it to its source memories. Ratification promotes it to `active`.
       */
      content: string;
      key: string;
      projectId?: string;
      memoryType: 'fact' | 'preference' | 'decision' | 'conversation';
      importance: number;
      confidence: number;
      /** IDs of the memories the proposal was derived from. */
      fromMemoryIds: string[];
      /** Human-readable rationale, stored on the tentative row. */
      rationale: string;
    }
  | {
      type: 'SUPERSEDE';
      /** Memory that is being replaced. */
      oldMemoryId: string;
      /** New memory that supersedes it (already written by CONSOLIDATE). */
      newMemoryId: string;
    };

/**
 * Aggregated result of a Dream run, for logging + the `dream_runs` audit row.
 */
export interface DreamRunResult {
  runId: string;
  userId: string;
  startedAt: string;
  finishedAt: string;
  phase1: { consolidated: number; deleted: number; kept: number };
  phase2?: { proposed: number };
  phase3: { sanitized: number; rejectedDuplicates: number };
  apply: { applied: number; skipped: number; failed: number };
  /** Usage/cost roll-up across all LLM calls in this run. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
