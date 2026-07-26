// Web HTTP API — request/response body types for low-complexity routes.
//
// Each type below is hand-ported from the Web tier's source of truth.
// Source paths are noted on each type for `scripts/regen-web.py` to
// track drift. Field names, optionality, and literal-union members
// must stay 1:1 with the source — only the runtime schema library
// (zod) is dropped in favor of plain TypeScript interfaces.

// Source: /types/workflow.ts (UserMessagePart, indirectly) and
// /app/api/cli/chat/route.ts:33-67 (requestSchema).
//
// The source schema uses zod with several recursive/external types
// (WorkflowUIMessage['parts'][number], chatMessageMetadataSchema,
// clientSpoofEnum). For the SDK we surface a simplified wire shape:
// - `input.parts` is `unknown[]` (callers serialize the same shape the
//   Web tier accepts; the SDK does not re-derive the parts union).
// - `input.metadata` is `Record<string, unknown>` (chat message
//   metadata is a free-form object map at the wire boundary).
// - `clientSpoof` is the literal union the zod enum accepts.
//
// If the Web tier tightens these (e.g. narrows `parts` to a known
// discriminated union), update this interface together with the source.
export interface CliChatRequestBody {
  id: string;
  trigger: 'submit-message' | 'regenerate-message' | 'route-message';
  messageId?: string;
  model?: string;
  input?: {
    text?: string;
    parts?: unknown[];
    metadata?: Record<string, unknown>;
  };
  /** Flat message array; same caveat as `input.parts` — `unknown[]`. */
  messages?: unknown[];
  /** CLI source fields: */
  clientId: string;
  label?: string;
  /** Merged AGENTS.md content from the CLI host's filesystem. */
  agentsMd?: string;
  /** CLI /plan toggle (read-only tool filter). */
  planMode?: boolean;
  /** CLI /effort thinking level; 'off' / undefined = no reasoning field. */
  thinkingLevel?: string;
  /** Experimental client impersonation profile (zod enum: 'off' | 'on'). */
  clientSpoof?: 'off' | 'on';
}

// Source: /app/api/cli/tool-result/route.ts:13-19
export interface CliToolResultBody {
  sessionId: string;
  toolCallId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

// Source: /app/api/cli/schedules/route.ts:46-74
//
// Discriminated union on `type`. The source zod schema also folds in
// `nodeRoutingSchema` (preferredNodeId / allowedNodes / autoFallbackNode)
// on both variants; those fields are mirrored here verbatim.
export interface ScheduleNodeRouting {
  /** Preferred agentd node id; null/undefined = no preference. */
  preferredNodeId?: string | null;
  /** Restrict dispatch to this allow-list of node ids. */
  allowedNodes?: string[] | null;
  /** Auto-fallback to any healthy node if preferred/allowed fail. */
  autoFallbackNode?: boolean;
}

export interface CreateDelayScheduleTaskBody extends ScheduleNodeRouting {
  type: 'delay';
  sessionId: string;
  title?: string | null;
  prompt: string;
  /** ISO-8601 datetime string (zod `.iso.datetime()`). */
  runAt: string;
  notifyChannel?: string | null;
  /** Route execution through the caller's CLI remote-control session. */
  remoteControl?: boolean;
}

export interface CreateDailyScheduleTaskBody extends ScheduleNodeRouting {
  type: 'daily';
  sessionId: string;
  title?: string | null;
  prompt: string;
  /** Local time-of-day string (zod `.min(1)`; format validated server-side). */
  dailyTime: string;
  timezone?: string;
  notifyChannel?: string | null;
  remoteControl?: boolean;
}

export type CreateScheduleTaskBody =
  | CreateDelayScheduleTaskBody
  | CreateDailyScheduleTaskBody;

// Source: /lib/cli/schedule-serialization.ts:12-42
//
// Serialized schedule task record returned by GET /api/cli/schedules
// and the read side of the schedules API. Zero external dependencies
// in the source (the function returns this exact shape); mirrored as a
// plain interface. `type` is `'delay' | 'daily'` (from
// /lib/core/db/scheduled.ts `ScheduledTaskType`).
export type ScheduleTaskType = 'delay' | 'daily';

export type ScheduleDisplayStatus = 'scheduled' | 'archived';

export interface ScheduleTaskRecord {
  id: string;
  sessionId: string;
  type: ScheduleTaskType;
  title: string | null;
  prompt: string;
  timezone: string | null;
  dailyTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastFiredFor: string | null;
  scheduleWorkflowRunId: string | null;
  lastChatRunId: string | null;
  active: boolean;
  archived: boolean;
  displayStatus: ScheduleDisplayStatus;
  notifyChannel: string | null;
  remoteControl: boolean;
  // Node-routing preferences (Web tasks only; ignored for remoteControl).
  preferredNodeId: string | null;
  allowedNodes: string[] | null;
  autoFallbackNode: boolean;
  // Failure tracking. failureCount is consecutive failures (cleared on
  // any success); disabledByFailure is true when the task was auto-
  // disabled by the dispatch path, distinguishing it from a user
  // manually setting active=false.
  failureCount: number;
  disabledByFailure: boolean;
  createdAt: string;
  updatedAt: string;
}

// Source: /lib/cli/remote-control.ts:116-127
//
// CLI remote-control online state, stored in KV under
// `cli-remote:<sessionId>` (TTL 120s). Read by the Web tier to decide
// whether a CLI is reachable for tool-request dispatch.
export interface CliRemoteState {
  online: boolean;
  tools: string[];
  capabilities: {
    hasDisplay: boolean;
    platform: string;
    isAdmin: boolean;
    scaleFactor: number;
  };
  connectedAt: number;
  cwd?: string;
  /**
   * MCP servers reachable from the attached CLI / desktop, reported by the
   * desktop renderer via /api/cli/session-events/:sessionId/register. Each
   * entry is a stdio command the desktop host is willing to spawn on
   * behalf of the agent. Workflow tool registration reads this list and,
   * for each server the Web allows, registers its tools as remote-call
   * tools dispatched back through the CLI SSE channel (same pattern as
   * computer-use-remote).
   *
   * Empty when the desktop has no MCP servers configured, or when the
   * connected client is a bare CLI (no desktop) — the field is optional
   * so older clients that never set it stay forward-compatible.
   */
  mcpServers?: CliRemoteMcpServer[];
}

/**
 * A single MCP server reported by the desktop. The Web does NOT trust the
 * `command` blindly — it cross-references against its own allowlist (admin-
 * configured) before registering tools, so a malicious / naive desktop can't
 * surface arbitrary local binaries to the model.
 */
export interface CliRemoteMcpServer {
  /** Stable name (matches the desktop's mcp config key). */
  name: string;
  /** Executable + args the desktop would spawn, e.g. ["npx", "-y", ...]. */
  command: string[];
  /** Optional env vars the desktop would set. Reported for visibility; the
   * Web never re-spawns the server itself, it only tells the desktop to. */
  env?: Record<string, string>;
  /** Transport the server speaks. stdio is the only one the desktop proxies. */
  transport: 'stdio';
}
