# Dream — Offline Memory Consolidation

Agentboster's Dream system is the offline pipeline that periodically
reorganizes a user's long-term memories: merging near-duplicates into
canonical facts, deleting redundant entries, and (Phase 2, TBD) proposing
novel cross-cluster connections as `tentative` memories awaiting
ratification.

Inspired by AutoGPT's `ref/autogpt_platform/backend/backend/copilot/dream/`
three-phase pipeline, adapted to agentboster's Postgres-only stack (no
Neo4j/FalkorDB dependency).

## Pipeline (P0 — Phase 1 + 3 + Apply)

```
external cron
   │
   ▼
POST /api/cron/dream  (CRON_SECRET)
   │
   ▼  fans out to one run per user with memories
   │
┌────────────────────────────────────────────────┐
│ runDreamForUser(userId)                        │
│                                                │
│  phase1            phase3            apply     │
│  consolidate  ───►  sanitize  ───►   write     │
│  (LLM merge)       (near-dup       (upsert +   │
│                     collapse)       delete)    │
└────────────────────────────────────────────────┘
   │
   ▼
dream_runs audit row (operations + result)
```

| Module | Role |
|---|---|
| `lib/memory/dream/types.ts` | `DreamOperation` / `DreamMeta` / `MemoryStatus` |
| `lib/memory/dream/bigram.ts` | Word-bigram Jaccard near-duplicate detection |
| `lib/memory/dream/phase1-consolidate.ts` | LLM-driven MERGE/DELETE/KEEP per concept group |
| `lib/memory/dream/phase3-sanitize.ts` | Pre-write dedupe + self-supersede guard |
| `lib/memory/dream/apply.ts` | DAL mutations (upsert + delete) |
| `lib/memory/dream/orchestrator.ts` | Phase sequencing + audit-row lifecycle |
| `lib/core/db/schema/dream.ts` + migration `0028_dream_runs.sql` | Audit table |
| `lib/core/db/memory/dream-runs.ts` | DAL for `dream_runs` |
| `app/api/cron/dream/route.ts` | External cron trigger (CRON_SECRET) |
| `lib/security/cron-auth.ts` | Constant-time CRON_SECRET verification |

## Why external cron (not in-process scheduler)

- **Vercel compatibility**: Next.js on Vercel is serverless; an in-process
  scheduler cannot survive between invocations. An external HTTP cron
  works identically on Vercel and self-hosted — same dual-deployment
  principle as the rest of the project.
- **No new runtime dependency**: the `cron` v4 library already in
  `dependencies` is used by callers for computing next-run times; the
  runtime schedule is owned by the platform (Vercel Cron / systemd).

## Triggering

Set `CRON_SECRET` in the environment, then point any HTTP-aware cron at
`POST /api/cron/dream` with `Authorization: Bearer <CRON_SECRET>`.

Vercel Cron (`vercel.json`):

```json
{
  "crons": [{ "path": "/api/cron/dream", "schedule": "0 3 * * *" }]
}
```

Self-hosted (systemd timer / external cron):

```cron
0 3 * * * curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/dream
```

Per-user re-run (debugging):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uuid>"}' \
  https://your-host/api/cron/dream
```

## P0 scope vs Phase 2+

- **P0 (current)**: Phase 1 consolidation with provenance audit. Source
  memories are deleted on consolidation (matches existing `compact.ts`
  semantics). Provenance is captured at the `dream_runs` row level.
- **Phase 2 (next)**: add `long_term_memories.dream_meta` jsonb column
  (`status`, `confidence`, `source_kind`, `provenance`) so source rows
  can be soft-superseded (kept for audit) instead of deleted. Then
  implement Phase 2 recombine — propose novel cross-cluster connections
  as `tentative` memories, gated by a ratification pass.

## Relationship to `lib/memory/compact.ts`

`compact.ts` remains the synchronous "compact now" entry point used by
the chat tools. Dream Phase 1 is the offline evolution: same merge
concept, but (a) bigram near-dup pre-filter, (b) operations returned
rather than applied inline, (c) provenance auditable via `dream_runs`.
