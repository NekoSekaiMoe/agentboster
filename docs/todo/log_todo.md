# Unified Trace Storage Refactor

## Status

Implementation in progress on `main` after `feat/unified-trace` was reviewed,
fixed, and merged.

The current branch unifies Trace IDs, query APIs, and the product UI while
preserving the existing model, tool activity, and security review storage.
The follow-up must make the canonical Trace store the source of truth instead
of extending the current cross-table aggregation layer.

## Target Model

Introduce a normalized Trace model with explicit causality:

- `trace_runs`: one row per Workflow run / top-level Trace.
- `trace_spans`: model steps, tool calls, agentd execution, and security review.
- `trace_events`: optional append-only state changes or diagnostics within a
  span when a single start/end record is insufficient.

Every record must use a common envelope:

- `trace_id`, `span_id`, and nullable `parent_span_id`.
- A durable `sequence` allocated monotonically within each Trace (or an
  equivalent total-order key). Concurrent sibling spans must sort by this key,
  with the stable span/event ID as the final tie-breaker; timestamps remain
  descriptive fields and must not be the only ordering mechanism.
- Stable source and event/span type strings.
- Status, start time, completion time, and duration.
- User, session, task, workspace, node, and agent identity where available.
- Structured input, output, error, and metadata payloads.
- An idempotency key that the producer reuses across retries. Enforce
  storage-level uniqueness for runs, spans, and events using the record kind,
  Trace/Span identifiers, and idempotency key; the ingestion DAL must use an
  atomic insert-on-conflict path so duplicate callbacks retain one record.

Do not implement this as one wide table or one opaque JSON document. Common
query fields belong in typed columns; source-specific details belong in
structured payload columns.

## Write-Path Cutover

- Add one Trace DAL / ingestion contract used by every producer.
- Persist the top-level run when a Workflow starts and finalize it on success,
  failure, cancellation, or timeout.
- Write model execution spans from Workflow step code.
- Write Web-hosted and MCP tool spans through the same DAL.
- Change agentd tool activity and security review callbacks to submit the
  canonical envelope, including parent span and idempotency information.
- Keep host-only database work inside `use step` functions; do not introduce
  top-level `node:*` imports into the Workflow bundle.
- Reject caller-supplied user identity at agentd boundaries. Continue deriving
  access through `resolveAgentdResourceAccess`.

## Migration And Compatibility

- Add schema migration, indexes, retention strategy, and cleanup behavior for
  the canonical tables.
- Backfill records that can be correlated safely. Mark uncorrelatable history
  explicitly instead of inventing Trace IDs.
- Deploy the Web receiver first. During a bounded compatibility window it must
  accept both the legacy callback shape and the canonical envelope, normalize
  both through an explicit protocol adapter, and dual-write old/new storage.
- Upgrade agentd only after the compatible Web receiver is live. Stop
  dual-write after all supported nodes meet the negotiated minimum protocol
  version and duplicate/divergence metrics remain clean for the agreed window.
- Rollback must keep both callback shapes accepted and resume legacy writes;
  document the version-negotiation response and the exact rollback order.
- Record metrics or logs for dual-write divergence and duplicate suppression.
- Bump the agentd version when the callback contract changes.
- Run the matching SDK drift generators for Web, Workflow, and agentd shapes.
- Verify both Vercel/Neon and self-hosted Postgres migration paths.

## Read-Path Cutover

- Make Trace list, detail, timeline, statistics, audit export, and CSV read from
  the canonical store.
- Remove cross-table Trace aggregation after backfill and dual-write validation
  are complete.
- Keep legacy audit endpoints only for an explicit compatibility period; do
  not leave them as a permanent second source of truth.
- Preserve user and workspace isolation in every Trace query.

## Legacy Storage Retirement

- Inventory every reader and writer of the current model, tool activity, and
  security review logs.
- Decide which domain-specific records still have value outside tracing. Such
  records may remain, but Trace Explorer must not depend on them.
- Stop legacy writes only after all supported producers use the canonical
  ingestion contract.
- Remove obsolete columns, indexes, DAL methods, API response fields, and UI
  fallback code in a dedicated cleanup migration.

## Acceptance Criteria

- One Trace query reconstructs the complete ordered execution without joining
  legacy audit tables.
- Parent/child relationships distinguish model steps, nested tools, agentd
  work, and security decisions instead of relying only on timestamps.
- Workflow retry/replay and duplicate callbacks are idempotent.
- Success, failure, cancellation, timeout, and pending states are represented
  consistently across all producers.
- Trace reads cannot expose another user's or workspace's data.
- Existing historical records either migrate correctly or have an explicit,
  tested legacy behavior.
- Focused DAL, API, Workflow propagation, agentd callback, malformed-response,
  and migration tests pass.
- `yarn check:lint`, `yarn test`, and the required Workflow `yarn build` gate
  pass; agentd passes `go test ./...`, `go vet ./...`, and `go build ./...`.
- The legacy aggregation implementation and temporary dual-write path are
  removed before declaring the refactor complete.

## Recommended Sequence

1. Review and stabilize `feat/unified-trace` without expanding its storage
   scope.
2. Merge it as the product-level baseline.
3. Create a dedicated canonical Trace storage branch.
4. Add schema and ingestion contract, then enable bounded dual-write.
5. Backfill and compare old/new reads using production-shaped fixtures.
6. Switch all read paths to the canonical store.
7. Remove legacy Trace aggregation, fallback reads, and obsolete storage.
