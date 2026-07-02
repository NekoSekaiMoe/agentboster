/**
 * Map the CLI's `local_*` tool vocabulary to agentd's internal tool
 * names + parameter shapes. The CLI runs `local_*` for historical
 * reasons (it predated agentd); agentd registers tools as
 * `exec`/`read`/`write`/`grep`/`ask_question` (see
 * subpackage/agentd/internal/agent/tools_*.go). Without this mapping,
 * forwarding `local_exec` to agentd would fail with "unknown tool".
 *
 * `local_ask_question` is intentionally NOT mapped — it needs the
 * CLI's TTY and is short-circuited client-side, never reaching the
 * forwarding proxy.
 *
 * Extracted to its own module so the route handler and the contract
 * test share the same source of truth.
 *
 * Verified against subpackage/agentd/internal/agent/tools_file.go
 * (read/write/grep) and tools_exec.go (exec).
 */
export function mapLocalToolToAgentd(
  toolName: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } | null {
  switch (toolName) {
    case 'local_exec': {
      // CLI uses `cwd`, agentd uses `working_dir`.
      const out: Record<string, unknown> = { command: input.command };
      if (typeof input.cwd === 'string' && input.cwd) {
        out.working_dir = input.cwd;
      }
      return { name: 'exec', input: out };
    }
    case 'local_read_file':
      return { name: 'read', input: { path: input.path } };
    case 'local_write_file':
      return {
        name: 'write',
        input: { path: input.path, content: input.content },
      };
    case 'local_grep': {
      // agentd's grep only supports pattern + path. Drop glob,
      // ignoreCase, literal, context, limit — they have no agentd
      // equivalent. The caller (LLM) is told paths are remote, so a
      // degraded search is acceptable.
      const out: Record<string, unknown> = { pattern: input.pattern };
      if (typeof input.path === 'string' && input.path) {
        out.path = input.path;
      }
      return { name: 'grep', input: out };
    }
    default:
      return null;
  }
}
