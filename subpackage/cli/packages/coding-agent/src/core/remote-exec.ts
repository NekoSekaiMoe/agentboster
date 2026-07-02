/**
 * Process-wide switchable remote execution target for the CLI.
 *
 * `/switch` lets the user redirect `local_*` tool execution from the
 * CLI host to a remote Agent Daemon node. When a target is set,
 * `handleLocalToolRequest` (main.ts) forwards each tool call to
 * `/api/cli/exec-on-agentd` instead of running it locally; the tool
 * names and schemas stay identical so the LLM's tool set is unchanged.
 *
 * The state is process-wide (not per-session) because a single CLI
 * process drives one user, and switching targets mid-session is the
 * intended use. The state is in-memory only; restarting the CLI
 * resets to local execution, which is the safe default.
 */

export interface RemoteExecTarget {
  /** agentd node id (matches a row in the Web `agentd_nodes` table). */
  nodeId: string;
  /** Human-readable label for status display (derived from the node id). */
  label: string;
  /** Sandboxes the node advertises (e.g. docker, lxc). Shown in status. */
  sandboxes: string[];
}

let current: RemoteExecTarget | null = null;

/**
 * One-shot notice injected before the user's next prompt after a
 * switch. Set by setRemoteExecTarget / clearRemoteExecTarget, consumed
 * and cleared by the interactive mode's onSubmit. This avoids spending
 * an extra agent turn just to acknowledge the switch — the notice
 * travels as a prefix on the user's next real message.
 */
let pendingNotice: string | null = null;

export function getRemoteExecTarget(): RemoteExecTarget | null {
  return current;
}

export function isRemoteExecActive(): boolean {
  return current !== null;
}

export function consumePendingNotice(): string | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}

export function setRemoteExecTarget(target: RemoteExecTarget | null): void {
  current = target;
  if (target) {
    const sandbox =
      target.sandboxes.length > 0 ? target.sandboxes.join('/') : 'unknown';
    pendingNotice =
      `[system notice] Tool execution has been switched to remote Agent Daemon node "${target.label}" (sandbox: ${sandbox}). ` +
      'local_exec / local_read_file / local_write_file / local_grep now run on that node, not on this machine. ' +
      'Paths you send are resolved on the node. Do not assume paths from earlier in this session are still valid on the new host — ' +
      're-check the working directory (e.g. run `pwd`) before using any absolute path.';
  }
}

export function clearRemoteExecTarget(): void {
  if (current) {
    pendingNotice =
      `[system notice] Tool execution has been switched back to this machine (was: ${current.label}). ` +
      'local_* tools now run locally again. Paths are once more resolved on this host.';
  }
  current = null;
}
