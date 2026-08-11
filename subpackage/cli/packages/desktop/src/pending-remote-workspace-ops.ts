/**
 * Pure pending-remote-workspace-op queue logic (no I/O).
 *
 * Extracted from main.ts so the flush/merge semantics are unit-testable
 * without the Tauri/DOM bootstrap. main.ts owns persistence
 * (localStorage); this module owns identity, equality, and the
 * post-flush merge rules.
 *
 * Concurrency contract: flushPendingRemoteWorkspaceOps() snapshots the
 * queue, processes it with awaits in between, then merges. During those
 * awaits the user can record NEW ops — including a rename that REPLACES
 * a queued rename for the same workspace with a newer title. The merge
 * must therefore:
 *
 *   - drop a processed entry ONLY when the persisted copy is unchanged
 *     (a same-identity rename with a DIFFERENT title is a newer user
 *     edit, not the op that was just completed);
 *   - never duplicate a retry entry that the persisted queue already
 *     holds (the persisted copy is at least as fresh as the snapshot).
 */

export type PendingRemoteWorkspaceOp =
  | { kind: 'create'; localId: string }
  | { kind: 'archive'; workspaceId: string }
  | { kind: 'rename'; workspaceId: string; title: string };

/**
 * Identity equality (JSON round-trips break reference identity). Renames
 * match on workspaceId ALONE — the title is the payload, not part of the
 * identity. Used for dedup on record and for detecting that the
 * persisted queue already holds (a possibly newer copy of) an op.
 */
export function pendingRemoteWorkspaceOpsEqual(
  a: PendingRemoteWorkspaceOp,
  b: PendingRemoteWorkspaceOp,
): boolean {
  if (a.kind === 'create' && b.kind === 'create') {
    return a.localId === b.localId;
  }
  if (a.kind === 'archive' && b.kind === 'archive') {
    return a.workspaceId === b.workspaceId;
  }
  if (a.kind === 'rename' && b.kind === 'rename') {
    return a.workspaceId === b.workspaceId;
  }
  return false;
}

/**
 * Full-payload equality: identity AND payload. For rename this includes
 * the title, so a completed rename{A} does NOT match a persisted
 * rename{B} that replaced it mid-flush.
 */
export function pendingRemoteWorkspaceOpSamePayload(
  a: PendingRemoteWorkspaceOp,
  b: PendingRemoteWorkspaceOp,
): boolean {
  if (!pendingRemoteWorkspaceOpsEqual(a, b)) return false;
  if (a.kind === 'rename' && b.kind === 'rename') {
    return a.title === b.title;
  }
  return true;
}

/**
 * Compute the queue to persist after a flush pass.
 *
 * @param passOps    the snapshot the pass processed (every entry was
 *                   either completed or pushed to `remaining`)
 * @param remaining  entries that failed transiently and must be retried
 * @param persisted  the CURRENT persisted queue (may contain ops
 *                   recorded during the flush, or newer payloads that
 *                   replaced snapshot entries)
 */
export function mergeQueueAfterFlush(
  passOps: PendingRemoteWorkspaceOp[],
  remaining: PendingRemoteWorkspaceOp[],
  persisted: PendingRemoteWorkspaceOp[],
): PendingRemoteWorkspaceOp[] {
  const retried = new Set(remaining);
  const processed = passOps.filter((op) => !retried.has(op));
  // Drop from the persisted queue only the entries this pass COMPLETED
  // whose payload is unchanged. A rename re-recorded with a newer title
  // mid-flush shares the completed op's identity but is a NEWER user
  // edit — dropping it would let the next merge revert the local title
  // to the stale remote one.
  const current = persisted.filter(
    (entry) =>
      !processed.some((op) => pendingRemoteWorkspaceOpSamePayload(op, entry)),
  );
  // Retry entries already present in the persisted queue (unchanged, or
  // superseded by a newer payload for the same identity) must not be
  // duplicated — the persisted copy is at least as fresh as `remaining`.
  const retry = remaining.filter(
    (op) =>
      !current.some((entry) => pendingRemoteWorkspaceOpsEqual(entry, op)),
  );
  return [...current, ...retry];
}
