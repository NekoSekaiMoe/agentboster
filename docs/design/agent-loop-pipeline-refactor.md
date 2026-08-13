# Agent Loop Middleware Pipeline — Refactor Plan (#21)

> Status: plan only. The refactor is a structural change to a hot 922-line file (`lib/workflow/agent/index.ts`); it warrants its own PR with full validation, not a ride-along. This document captures the proposed stage layout + ordering constraints so the eventual refactor has a clear target.

## What deer-flow does

deer-flow's `make_lead_agent` assembles the agent from a deterministic, ordered chain of `AgentMiddleware` (~30 of them), each owning one concern: summarization, loop detection, token budget, clarification, memory, view-image, system-message coalescing, deferred-tool-filter, subagent-limit, terminal-response, safety-finish-reason, etc. A single `build_middlewares()` function pins the order and documents *why* (e.g. "SystemMessageCoalescingMiddleware must precede ClarificationMiddleware because…").

## agentboster's current state

`chatWorkflow` (lib/workflow/agent/index.ts, 922 lines) does the equivalent work but as ONE large function body — the concerns are inline blocks rather than discrete middleware. Identified concerns + their current sites:

| Concern | Current site (index.ts) | What it does |
|---|---|---|
| Tool registration / filtering | before `streamText` | drop state-mutating tools in plan mode; CLI-only `local_*`; workspace-lock-gated execute |
| Provider-compat message normalization | `prepareStep` (~568) | strip orphan tool calls/results, merge adjacent assistant turns, enforce alternation |
| Autocompact threshold check | `prepareStep` (~442) | fold old tool results before the model call |
| Provider mismatch detection | `onStepFinish` (~697) | surface "stop + toolCalls" Responses-API bug |
| Tool-loop circuit breaker | `onStepFinish` (~728) | `toolLoopGuard.observe` + trip → throw |
| Step persistence + usage | `onStepFinish` (~756) | `persistStepDeltaAndUsageStep` |
| Stream message write | throughout | `writeMessageMetadata` / `writeStreamError` / `writeStreamClose` |
| Run finalization | `finalizeRunStep` (~789, ~892) | status, KV bump, post-run-cleanup spawn |
| Step budget | `maxSteps` (~386) | bounded autonomy |

These are correctly interleaved today, but the ordering invariants are implicit (no single document says "X must precede Y because Z"). That's the gap vs deer-flow.

## Proposed target: a staged pipeline with a documented order

NOT a runtime middleware abstraction (the workflow DevKit's step model doesn't expose a middleware hook chain the way LangChain does). Instead: extract each concern into a named module with a narrow signature, and document the call order in ONE place. `chatWorkflow` becomes a thin orchestrator that calls them in the documented sequence.

### Stage layout (proposed)

```
┌─ 1. BUILD TOOLS ────────────────────────────────────────────────────
│  buildToolsForRun({ source, planMode, workspaceLockAcquired })
│  → drops state-mutating tools (plan mode), gates local_* (CLI), gates
│    execute (workspace lock). PURE; no ordering constraint beyond
│    "before streamText".
│
┌─ 2. PREPARE STEP (per-step, before each model call) ────────────────
│  a. normalizeProviderCompatMessages(messages, providerCompat)
│     → strip orphans, merge, enforce alternation. MUST run before
│       autocompact so the threshold sees clean messages.
│  b. maybeAutocompact(history, threshold)
│     → fold old tool results. MUST run after (a) and before the model
│       call.
│
┌─ 3. STEP FINISH (per-step, after each model call) ──────────────────
│  a. detectProviderMismatch(step, providerName)
│     → returns { isMismatch, errorText }. MUST run FIRST — a mismatch
│       invalidates everything downstream for this step.
│  b. observeToolLoop(step, toolLoopGuard)
│     → returns { tripped, tripReason, snapshot }. MUST run after (a)
│       (no point looping on a mismatched step). Trips → #18 strip-not-
│       raise (migration target) instead of throw.
│  c. persistStepDelta(step)
│     → MUST run after (a)+(b) so we don't persist a step we then reject.
│
┌─ 4. FINALIZE RUN (once, at end) ────────────────────────────────────
│  a. finalizeRunStep({ status, failureReason })
│  b. spawnPostRunCleanup({ sessionId, userId, ... })  // fire-and-forget
│  c. writeStreamClose()
│  Order: (a) before (b) so cleanup sees the committed final status;
│         (b) fire-and-forget before (c) so the stream-close doesn't
│         race the cleanup spawn.
```

### Documented ordering constraints (the docstrings that matter)

1. **normalizeProviderCompat BEFORE maybeAutocompact** — autocompact's threshold sees the post-normalization message count; normalizing after compacting would re-introduce orphans into an already-trimmed window.
2. **detectProviderMismatch BEFORE observeToolLoop** — a mismatched step (stop + toolCalls) would otherwise look like a normal step to the loop guard; checking mismatch first avoids a false loop trip.
3. **persistStepDelta AFTER mismatch + loop checks** — don't persist a step that's about to be rejected.
4. **finalizeRunStep BEFORE spawnPostRunCleanup** — the cleanup workflow reads the committed final status from the DB; finalizing out-of-order means cleanup gates on stale state.
5. **spawnPostRunCleanup (fire-and-forget) BEFORE writeStreamClose** — the spawn is non-blocking, but issuing it before closing the stream guarantees the cleanup isn't orphaned if the response closes first.

## Migration path (when this is executed)

1. Extract each concern into `lib/workflow/agent/stages/` (one file each), preserving current behavior exactly. Each is a pure function with the signature above. Land behind no flag — `chatWorkflow` calls them inline.
2. Add the ordering docstrings to `chatWorkflow` (the single document of "X must precede Y because Z").
3. Add tests per stage (most are untestable today because they're inline). The predicates in #18 (stop-reason) and #20 (checkpoint-lineage) are already extracted; this refactor extends that pattern to the rest.
4. Migrate the two throw sites (maxSteps, toolLoopGuard) to strip-not-raise (#18) once the persistence stage can carry `stopReason`.

## Why not do it now

- The 922-line file works correctly today; the concerns are interleaved properly. The refactor is correctness-neutral if done right and regression-prone if rushed.
- It's a structural change to the hot agent path — every chat run flows through it. A dedicated PR with the full validation cycle (tsc + lint + the 1500-test suite + manual chat smoke) is the responsible scope, not a ride-along in the deer-flow borrowings batch.
- The ordering invariants are the real deliverable; this document captures them. The extraction can follow incrementally (one stage per PR) without risk.

## What landed in this batch

This doc + the already-extracted primitives (stop-reason #18, checkpoint-lineage #20, delegation-ledger #17, session-goal #14) establish the pattern: narrow pure modules with documented invariants, testable in isolation. The eventual index.ts refactor follows the same pattern at scale.
