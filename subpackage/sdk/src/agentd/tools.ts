// agentd tool exec protocol.
//
// Sources of truth:
//   - subpackage/agentd/internal/agent/manager.go:408-422 —
//     `ToolExecRequest` / `ToolExecResponse` (synchronous exec path).
//   - subpackage/agentd/internal/agent/tools.go:11-24 —
//     `ToolResult` / `ToolDefinition` / `ToolHandler` (tool registry).
//   - subpackage/agentd/internal/server/exec_stream.go:208-236 —
//     SSE streaming exec events.
//
// Drift between the daemon Go side and the Web TS client is
// intentional in one place: the Web `AgentdToolExecRequest`
// (lib/extra/agent/agentd-tools-client.ts:13-17) omits `task_id`,
// `user_id`, and `roles` because the Web client trusts the session
// row for those fields. The Go side carries them so the daemon can
// authorize without an extra lookup. This SDK type follows the **Go
// (daemon) shape** as authoritative — the optional fields cover the
// Web client's narrower use.
//
// Drift is reported by `scripts/regen-agentd.py`.

// Source: subpackage/agentd/internal/agent/manager.go:408-415
/**
 * Synchronous tool execution request, sent to `/api/v1/tools/:name`.
 *
 * The Web client (`lib/extra/agent/agentd-tools-client.ts`) sends
 * `session_id` / `tool_name` / `tool_input`, plus `workspace_id` when
 * the per-workspace run lock is held; the daemon
 * also accepts `task_id` / `user_id` / `roles` so it can authorize
 * and audit without a separate lookup, and `workspace_id` to scope
 * the long-lived container + exec lock (M0b; the Web client sends it
 * whenever the per-workspace run lock is held). Other optional fields
 * are omitted by the Web client today.
 */
export interface ToolExecRequest {
  session_id: string;
  task_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  user_id?: string;
  roles?: string[];
  workspace_id?: string;
  /**
   * Web-tier workflow run id for cross-tier tracing. Propagated by
   * the daemon onto any Task it creates (and thus any callback back to
   * the Web) so the Web can correlate a callback to its run. Omitted
   * for non-traced paths. (Tier 2 cross-tier tracing.)
   */
  run_id?: string;
}

// Source: subpackage/agentd/internal/agent/manager.go:417-422
/**
 * Result envelope returned by the synchronous tool exec endpoint.
 *
 * This is the **outer** envelope the daemon returns over HTTP — the
 * same shape as `APIResponse<string>`. The inner tool's own success
 * flag (`ToolResult.success`) is what callers should branch on after
 * confirming the outer envelope is valid.
 */
export interface ToolExecResponse {
  success: boolean;
  data?: string;
  error?: string;
}

// Source: subpackage/agentd/internal/agent/tools.go:11-16
/**
 * Unified tool handler return type. Every tool built into or
 * registered with agentd returns this shape; the daemon's tool
 * registry wraps it into a `ToolExecResponse` for the HTTP path.
 */
export interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
}

// Source: subpackage/agentd/internal/agent/tools.go:18-24
/**
 * OpenAI Function-Calling-compatible tool definition exposed to the
 * model. `Parameters` is a JSON Schema object describing the tool's
 * input shape; `MinUserType` is daemon-internal (controls which user
 * tiers may invoke the tool) and is **not** serialized to the model.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool input. */
  parameters: unknown;
}

// ── SSE streaming exec events ─────────────────────────────────────
//
// Source: subpackage/agentd/internal/server/exec_stream.go:208-236.
// The streaming endpoint emits one SSE event per output chunk, then a
// terminal `done` or `error` event. The SSE `event:` line matches the
// `type` field inside the JSON payload; consumers should switch on
// the `type` discriminator after parsing the `data:` line.

// Source: subpackage/agentd/internal/server/exec_stream.go:208-216
export interface ExecStreamOutputEvent {
  type: 'output';
  chunk: string;
  /** ISO8601 / RFC3339 timestamp of when the chunk was emitted. */
  at: string;
}

// Source: subpackage/agentd/internal/server/exec_stream.go:218-226
export interface ExecStreamDoneEvent {
  type: 'done';
  exit_code: number;
  /** ISO8601 / RFC3339 timestamp of when the command exited. */
  at: string;
}

// Source: subpackage/agentd/internal/server/exec_stream.go:228-236
export interface ExecStreamErrorEvent {
  type: 'error';
  error: string;
  /** ISO8601 / RFC3339 timestamp of when the error occurred. */
  at: string;
}

// Source: subpackage/agentd/internal/server/exec_stream.go:208-236
/**
 * Discriminated union of all events the streaming exec endpoint
 * (`/api/v1/exec-stream`) can emit. Switch on `event.type`.
 */
export type ExecStreamEvent =
  | ExecStreamOutputEvent
  | ExecStreamDoneEvent
  | ExecStreamErrorEvent;
