# Dream — Offline Memory Consolidation

Agentboster's Dream system is the offline pipeline that periodically
reorganizes a user's long-term memories: merging near-duplicates into
canonical facts, deleting redundant entries, and (Phase 2, TBD) proposing
novel cross-cluster connections as `tentative` memories awaiting
ratification.

Inspired by AutoGPT's `ref/autogpt_platform/backend/backend/copilot/dream/`
three-phase pipeline, adapted to agentboster's Postgres-only stack (no
Neo4j/FalkorDB dependency).

## Pipeline

```
external cron
   │
   ▼
POST /api/cron/dream  (CRON_SECRET)
   │
   ▼  fans out to one run per user with memories
   │
┌──────────────────────────────────────────────────────────┐
│ runDreamForUser(userId)                                  │
│                                                          │
│  phase1            phase2            phase3       apply  │
│  consolidate  ───►  recombine  ───►  sanitize  ───► write │
│  (LLM merge)       (cross-cluster  (near-dup           │
│                     findings)        collapse)          │
└──────────────────────────────────────────────────────────┘
   │
   ▼
dream_runs audit row (operations + result)
```

| Module | Role |
|---|---|
| `lib/memory/dream/types.ts` | `DreamOperation` / `DreamMeta` / `MemoryStatus` |
| `lib/memory/dream/bigram.ts` | Word-bigram Jaccard near-duplicate detection |
| `lib/memory/dream/phase1-consolidate.ts` | LLM-driven MERGE/DELETE/KEEP per concept group |
| `lib/memory/dream/phase2-recombine.ts` | Cross-cluster novel findings via embedding + LLM |
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

## Current scope vs remaining work

- **Phase 1 consolidation** (shipped): merges near-duplicate memories
  within a key-prefix group, records provenance on the `dream_runs`
  row. Sources are currently deleted (matches `compact.ts` semantics).
- **Phase 2 recombine** (shipped): cross-cluster novel findings. Embeds
  sampled representatives per group, ranks cross-group pairs by cosine,
  and asks the LLM to propose non-obvious insights. Output lands as
  `dream.proposal.*` tentative keys excluded from recall until ratified.
  Bounded cost (see `phase2-recombine.ts` caps).
- **Phase 3 sanitize** (shipped): near-dup collapse + self-supersede
  guard before writes.
- **Apply** (shipped): DAL mutations.
- **TODO: `dream_meta` jsonb column** on `long_term_memories`. Once
  added, `apply.ts` switches from delete to soft-supersede
  (`status='superseded'`) so source rows survive for audit, and
  `dream.proposal.*` rows carry `status='tentative'` inline rather than
  relying on the key-prefix convention.
- **TODO: ratification pass** that promotes ratified `tentative`
  memories to `active` (currently they stay behind the proposal prefix
  indefinitely).

## Relationship to `lib/memory/compact.ts`

`compact.ts` remains the synchronous "compact now" entry point used by
the chat tools. Dream Phase 1 is the offline evolution: same merge
concept, but (a) bigram near-dup pre-filter, (b) operations returned
rather than applied inline, (c) provenance auditable via `dream_runs`.
