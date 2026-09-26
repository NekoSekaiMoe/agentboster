# Agent Note: Session runtime completion and replay ordering

Status: implemented

## Problem

A custom message can start a run inside an `agent_settled` handler before the
remaining handlers finish. Context edits made while streaming are persisted but
leave live provider context stale. Compaction replay labels interactive input
as RPC. A failed imported-session cwd check leaves a copied file occupying the
retry destination.

## Decision

Custom trigger turns use the existing settled action queue. Pending context
edits refresh live context once the run finishes, before settled handlers see
it, including on failure. Idle edits still refresh immediately. `steer` and
`followUp` accept an input source with the existing RPC default; compaction
replay explicitly supplies `interactive` and performs interception once.

Import removes only its new copy when opening or cwd validation fails, before
runtime teardown. The source and any pre-existing colliding session remain
intact, so a cwd override retry selects the same available destination.

## Alternatives considered

- Start custom turns during dispatch: later handlers can observe a reentrant
  run and miss the stable completion state.
- Refresh streaming context immediately: mutates the active run's context and
  violates the existing refresh guard.
- Remember failed import targets across calls: adds runtime state when removing
  the uncommitted copy already restores destination selection.

## Consequences

Extensions see refreshed context at settlement and requested custom turns start
after all handlers finish. Edits do not alter the active streaming response.
Import retries recopy the source; failures after runtime teardown retain the
imported file for recovery. Regression tests use controlled agent boundaries
and real session persistence without provider calls.
