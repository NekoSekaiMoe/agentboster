-- Add Dream lifecycle columns to long_term_memories.
--
-- `dream_status` (active|tentative|superseded|contradicted) is the
-- recall-visible lifecycle flag. Default 'active' so every legacy row
-- and every extractor write stays recallable — only Dream Phase 2
-- (tentative) and Phase 1 consolidation (superseded) write non-active
-- values, plus the ratification pass flips tentative → active.
--
-- `dream_meta` is a jsonb sidecar for confidence / source_kind /
-- provenance — fields the UI and audit read but recall does NOT filter
-- on, so jsonb is fine (no index, no WHERE predicate).
--
-- Why a top-level column instead of a jsonb field: recall does
-- `WHERE dream_status = 'active'` on every turn. A jsonb predicate
-- (`WHERE dream_meta->>'status' = 'active'`) cannot use a btree index
-- and would seq-scan as the table grows. Mirrors AutoGPT's Graphiti
-- edge `status` property, which lives on the edge itself for the same
-- reason (Cypher `WHERE e.status = 'active'` is native).
--
-- Backfill: every existing row defaults to ('active', NULL), which is
-- the correct back-compat behavior — legacy rows were all implicitly
-- active before this migration.

ALTER TABLE "long_term_memories" ADD COLUMN "dream_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "dream_meta" jsonb;--> statement-breakpoint
-- Partial index covering the recall hot path: active rows for a user.
-- Non-active rows (tentative/superseded/contradicted) are excluded from
-- the index so recall's `WHERE user_id=? AND dream_status='active'`
-- resolves via this index without ever touching the non-active tail.
-- Using a partial (not full) index keeps write cost down — every Dream
-- supersede just drops the row from this index rather than churning it.
CREATE INDEX "long_term_memories_dream_status_active_idx"
  ON "long_term_memories" ("user_id", "dream_status")
  WHERE dream_status = 'active';
