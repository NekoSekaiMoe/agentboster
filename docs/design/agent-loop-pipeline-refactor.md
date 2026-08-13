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

```text
┌─ 1. BUILD TOOLS ────────────────────────────────────────────────────
│  buildToolsForRun({ source, planMode, workspaceLockAcquired })
│  → drops state-mutating tools (plan mode), gates local_* (CLI), gates
│    execute (workspace lock). PURE; no ordering constraint beyond
│    "before streamText".
│
┌─ 2. PREPARE STEP (per-step, before each model call) ────────────────
│  Actual order (prepareStep, index.ts:586+):
│  a. writeMessageMetadata(stepNumber, createdAt) → UI-stream
│     step-start marker (side effect). Runs first so the UI timeline
│     matches the step boundary even if a later stage throws.
│  b. mapInstructionMessages(queued instructions) → map + stage queued
│     instruction messages. forceCompact is derived from the MAPPED
│     result here and feeds the compaction decision in (e).
│  c. microcompact(messages) → fold old tool results into placeholders
│     (no LLM call). Runs before the token estimate so the estimate
│     reflects the folded state.
│  d. estimatePromptTokens(folded) → re-estimate prompt tokens.
│  e. evaluateCompactionNeed(tokens, threshold, forceCompact) →
│     compression DECISION (pure), forced when (b) requested it.
│  f. compactAndPersistSummaryStep(...) → LLM summarize + persist
│     (side effect: DB), replace messages. Only when (e) fires.
│  g. append queued instruction prompt messages.
│  h. applyMessageCompat(messages, providerCompat) → strip orphans,
│     merge, enforce alternation. LAST, right before the model call.
│
│  NOTE: (h) running last is a deliberate correction of the original
│  "normalize BEFORE autocompact" idea. Compat normalization is
│  provider wire-shape repair — it does not change token semantics, so
│  the compression decision (e) is based on the raw messages; and
│  compaction itself emits well-formed messages, so normalizing last
│  cannot re-introduce orphans into the trimmed window — it repairs
│  exactly the prompt that goes on the wire.
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
│         (b) enqueued BEFORE (c) so the cleanup spawn isn't orphaned
│         if the response closes first. The caller awaits only the
│         enqueue (runId resolution), never cleanup completion.
│  IMPORTANT: the spawn's start() MUST run inside a 'use step'
│  function — workflow/api's start is a throwing stub when resolved
│  inside a workflow body (the package's "workflow" export condition
│  maps to api-workflow.js, which throws "Move this call to a step
│  function"); the real host-side implementation only resolves in step
│  functions. Pattern: wrap `await start(postRunCleanupWorkflow, …)`
│  in a 'use step' helper, like schedule.ts does for
│  scheduledTaskWorkflow.
```

### Documented ordering constraints (the docstrings that matter)

1. **microcompact/compaction BEFORE applyMessageCompat** — compat normalization is provider wire-shape repair and does not change token semantics, so the token estimate and compression decision run on the raw messages; compaction emits well-formed messages, so compat runs LAST on the final prompt and cannot re-introduce orphans into an already-trimmed window. This supersedes the original "normalize before autocompact" assumption — see the stage 2 NOTE above.
2. **detectProviderMismatch BEFORE observeToolLoop** — a mismatched step (stop + toolCalls) would otherwise look like a normal step to the loop guard; checking mismatch first avoids a false loop trip.
3. **persistStepDelta AFTER mismatch + loop checks** — don't persist a step that's about to be rejected.
4. **finalizeRunStep BEFORE spawnPostRunCleanup** — the cleanup workflow reads the committed final status from the DB; finalizing out-of-order means cleanup gates on stale state.
5. **spawnPostRunCleanup (enqueue) BEFORE writeStreamClose** — issuing the spawn before closing the stream guarantees the cleanup isn't orphaned if the response closes first. The spawn's `start()` call MUST live inside a `'use step'` function: `workflow/api`'s `start` is a throwing stub inside a workflow body (its "workflow" export condition resolves to `api-workflow.js`), so a bare `await start(...)` in `chatWorkflow` fails silently under the surrounding try/catch (only a `post-run-cleanup:spawn_failed` log — the cleanup never runs). The caller awaits only the enqueue (runId resolution), never the cleanup's completion; step execution is driven by the Queue Service.

## Migration path (when this is executed)

1. Extract each concern into `lib/workflow/agent/stages/` (one file each), preserving current behavior exactly. Land behind no flag — `chatWorkflow` calls them inline. Stages split into two kinds; do NOT pretend every stage is a pure function:
   - **Pure decision stages**: `buildToolsForRun`, `evaluateCompactionNeed` (token estimate + threshold decision), `detectProviderMismatch` — no I/O, no accumulated state, signature in / decision out.
   - **Stateful decision adapters**: `observeToolLoop` — `ToolLoopGuard.observe()` mutates per-run tracker state (malformed/failure counters, cycle fingerprints) as it decides, so the verdict is NOT a pure function of its inputs. When extracting, split the guard-state mutation from the pure loop verdict (snapshot in / decision out) so the judgment stays independently testable, and keep the guard instance as the cross-step history carrier — current cross-step behavior must be preserved exactly.
   - **Side-effect adapters**: `persistStepDelta` (DB write), `finalizeRunStep` (DB status + KV bump), `spawnPostRunCleanup` (workflow-run spawn, via a `'use step'` wrapper — see constraint #5), `writeStreamClose` / `writeMessageMetadata` (UI-stream writes), `compactAndPersistSummaryStep` (LLM call + DB summary persistence). These are thin wrappers around host resources.
   - Boundary note for `prepareStep`: it mixes both — the message-metadata write and summary persistence are the side-effect parts; microcompact / token estimation / the compaction decision are the pure parts. When extracting, keep the pure decisions separately testable from the persistence adapters.
2. Add the ordering docstrings to `chatWorkflow` (the single document of "X must precede Y because Z").
3. Add tests per stage (most are untestable today because they're inline). The predicates in #18 (stop-reason) and #20 (checkpoint-lineage) are already extracted; this refactor extends that pattern to the rest.
4. Migrate the two throw sites (maxSteps, toolLoopGuard) to strip-not-raise (#18) once the persistence stage can carry `stopReason`.

## Why not do it now

- The 922-line file works correctly today; the concerns are interleaved properly. The refactor is correctness-neutral if done right and regression-prone if rushed.
- It's a structural change to the hot agent path — every chat run flows through it. A dedicated PR with the full validation cycle (tsc + lint + the 1500-test suite + manual chat smoke) is the responsible scope, not a ride-along in the deer-flow borrowings batch.
- The ordering invariants are the real deliverable; this document captures them. The extraction can follow incrementally (one stage per PR) without risk.

## What landed in this batch

This doc + the already-extracted primitives (stop-reason #18, checkpoint-lineage #20, delegation-ledger #17, session-goal #14) establish the pattern: narrow pure modules with documented invariants, testable in isolation. The eventual index.ts refactor follows the same pattern at scale.
