// agentd clawless wire types — common shapes.
//
// Source of truth: subpackage/agentd/internal/clawless/types.go.
// The Go file declares ~30 structs; only the high-traffic wire
// types consumed by third-party integrators are mirrored here. The
// daemon-only and TOML-config structs are intentionally NOT ported.
//
// All field names follow the Go JSON tags (snake_case). `time.Time`
// ports to ISO8601 `string`; `*T` ports to optional `T?`; `any` /
// `json.RawMessage` port to `unknown`.
//
// Drift is reported by `scripts/regen-agentd.py`.

import type { AgentSandboxOverrides } from './sandbox.js';

// Source: subpackage/agentd/internal/clawless/types.go:5-15
/**
 * Task lifecycle status. Emitted by the daemon on task state
 * transitions and persisted on the `tasks` row mirrored to the
 * Web tier.
 */
export type TaskStatus =
  | 'pending'
  | 'reviewing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Source: subpackage/agentd/internal/clawless/types.go:18-35
/**
 * An agent task. Created when the daemon receives a task dispatch
 * (via `/api/v1/tasks` or the Web-tier dispatch path), updated as
 * the agent loop progresses, and persisted for audit.
 */
export interface Task {
  id: string;
  agent_id: string;
  session_id: string;
  user_id: string;
  roles: string[];
  source: BotSource;
  command: string;
  sandbox_type: string;
  sandbox_id: string;
  system_prompt?: string;
  env: Record<string, string>;
  /** Timeout in seconds. */
  timeout: number;
  status: TaskStatus;
  result: string;
  /** ISO8601 timestamp. */
  created_at: string;
  /** ISO8601 timestamp. */
  updated_at: string;
  /**
   * Web-tier workflow run id for cross-tier tracing. Propagated from
   * ToolExecRequest.run_id when a task originates from a tool exec.
   * Empty for tasks that did not originate from a traced tool exec.
   * (Tier 2 cross-tier tracing.)
   */
  run_id?: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:96-107
/**
 * One chat message in a session transcript. Carries the full OpenAI
 * tool-calling protocol: assistant turns may include tool_calls (the
 * model's request to invoke tools), and tool turns must reference the
 * originating tool_call via tool_call_id. Without these fields the
 * conversation history cannot pair a tool result with its call, which
 * breaks multi-turn tool calling on any spec-compliant provider.
 */
export interface Message {
  role: string;
  content: string;
  /** Present on role="assistant" turns where the model requested tools. */
  tool_calls?: ToolCall[];
  /** Present on role="tool" turns; matches the assistant tool_call.id. */
  tool_call_id?: string;
  /** Optional tool name on role="tool" turns. */
  name?: string;
  /** ISO8601 timestamp. */
  time: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:56-61
/**
 * A single tool invocation request as emitted by the model on an
 * assistant turn. Mirrors the OpenAI function/tool-calling shape.
 */
export interface ToolCall {
  id: string;
  /** "function" (the only type today). */
  type?: string;
  function: ToolCallFunction;
}

// Source: subpackage/agentd/internal/clawless/types.go:63-68
/**
 * The function part of a tool call.
 */
export interface ToolCallFunction {
  name: string;
  /** Raw JSON string of arguments per the OpenAI spec (NOT a parsed object). */
  arguments: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:71-75
/**
 * A tool definition advertised to the model for native tool calling.
 * Mirrors the OpenAI tools field shape. Used in LLM proxy requests.
 */
export interface ToolDef {
  /** "function". */
  type: string;
  function: ToolDefFunction;
}

// Source: subpackage/agentd/internal/clawless/types.go:77-81
/**
 * The function declaration of a tool.
 */
export interface ToolDefFunction {
  name: string;
  description: string;
  /** JSON-Schema-ish parameter declaration. */
  parameters: Record<string, unknown>;
}

// Source: subpackage/agentd/internal/clawless/types.go:59-62
/**
 * Structured key/value fact extracted from a session. Stored on the
 * session row and surfaced to the model for context recall.
 */
export interface KeyFact {
  key: string;
  value: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:103-111
/**
 * Agent memory entry. Persisted across task runs and surfaced to
 * the model when the agent is re-instantiated. `access_count` is
 * bumped on every read.
 */
export interface Memory {
  id: string;
  agent_id: string;
  key: string;
  value: string;
  source: string;
  /** ISO8601 timestamp. */
  created_at: string;
  access_count: number;
}

// Source: subpackage/agentd/internal/clawless/types.go:38-49
/**
 * A chat session. Sessions persist messages and key facts across
 * multiple task invocations.
 */
export interface Session {
  id: string;
  agent_id: string;
  user_id: string;
  roles: string[];
  source: BotSource;
  messages: Message[];
  summary: string;
  key_facts: KeyFact[];
  /** ISO8601 timestamp. */
  created_at: string;
  /** ISO8601 timestamp. */
  updated_at: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:137-178
/**
 * Agent configuration from ClawLess. Carried from the Web tier to
 * the daemon via `/api/agentd/v1/config`. Per-agent sandbox
 * resource overrides (`sandbox_cpu` / `sandbox_mem` / `sandbox_pids`
 * / `sandbox_disk` / `sandbox_blkio_weight`) are composed in from
 * {@link AgentSandboxOverrides} rather than redeclared here, so the
 * five sandbox_* fields have a single source of truth (sandbox.ts).
 * The composition is positional: callers that already hold a full
 * `AgentConfig` row can still access `agentConfig.sandbox_cpu` etc.
 * directly.
 */
export interface AgentConfig extends AgentSandboxOverrides {
  agent_id: string;
  default_sandbox: string;
  available_sandboxes: string[];
  l1_provider: string;
  l1_model: string;
  l1_endpoint: string;
  max_parallel_sub_agents: number;
  allowed_paths: string[];
  blocked_paths: string[];
  memory_enabled: boolean;
  system_prompt?: string;
  // P1.2: MCP bridge toggle and server allowlist.
  mcp_enabled: boolean;
  mcp_servers?: string[];
  // P3.1: multi-node filter — restricts which daemon nodes this
  // agent is allowed to run on. Empty = any node.
  allowed_nodes?: string[];
  // P2.2: outbound egress allowlist (glob). Empty = unrestricted
  // when sandbox network is on.
  egress_allowlist?: string[];
  // P1.1: use agent-specific L0 rules (sourced from agentL0Rules
  // table) in addition to the global DefaultPresets.
  custom_l0_rules: boolean;
}

// Source: subpackage/agentd/internal/clawless/types.go:208-213
/**
 * Health check response from `/api/v1/health`. `status` is `"ok"`
 * when the daemon is ready to accept requests; `uptime` is a
 * human-readable duration string.
 */
export interface HealthResponse {
  status: string;
  /** ISO8601 timestamp. */
  timestamp: string;
  version: string;
  uptime: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:225-233
/**
 * Originating bot context attached to a task / session. The daemon
 * uses this to route replies back through the correct adapter and
 * thread; missing fields are common for CLI/internal invocations.
 */
export interface BotSource {
  type?: string;
  adapter?: string;
  origin?: string;
  /** Chat-platform thread id (adapter-specific format). */
  threadId?: string;
  /** Chat-platform message id (adapter-specific format). */
  messageId?: string;
  /** Chat-platform user id (adapter-specific format). */
  userId?: string;
  userName?: string;
}

// Source: subpackage/agentd/internal/clawless/types.go:235-239
/**
 * Adapter capability flags, surfaced by the Web tier's
 * `/api/agentd/v1/bot-capabilities` endpoint. Drives tool and
 * reply-routing decisions on the daemon side (e.g. whether to
 * attempt a message edit vs. always send a fresh reply).
 */
export interface BotCapabilities {
  delete: boolean;
  edit: boolean;
  reaction: boolean;
}
