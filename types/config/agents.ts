import { z } from 'zod';
import { aiModelConfigSchema } from './ai';

/**
 * Single agent/bot configuration schema.
 *
 * P1.1: Extended with daemon-side knobs so per-agent sandbox/resource/MCP
 * settings can flow from this KV-stored record into the agentd AgentConfig
 * struct via the /api/agentd/v1/agent-config/:id route. All new fields are
 * optional — agents that don't set them fall back to daemon defaults.
 */
export const agentInstanceConfigSchema = z.object({
  /** Model configuration for this agent; overrides defaults when provided. */
  model: aiModelConfigSchema.optional(),
  /** System prompt that guides this agent's behavior. */
  system_prompt: z.string().optional(),
  /** Optional per-agent temperature override. */
  temperature: z.number().min(0).max(2).optional(),

  // ── P1.1: daemon-side knobs ───────────────────────────────────────

  /** Default sandbox type for tasks this agent runs. */
  sandbox_type: z.enum(['docker', 'docker-strict', 'lxc', 'auto']).optional(),
  /** CPU core limit (e.g., 0.5, 1.0, 2.0). */
  sandbox_cpu: z.number().positive().optional(),
  /** Memory limit, human-readable (e.g., "256m", "1g"). */
  sandbox_mem: z.string().optional(),
  /** PID fork limit inside the sandbox (Docker --pids-limit). */
  sandbox_pids: z.number().int().positive().optional(),
  /** Disk quota (e.g., "1g", "512m"). */
  sandbox_disk: z.string().optional(),
  /** Block IO weight, 10–1000 (Docker --blkio-weight). */
  sandbox_blkio_weight: z.number().int().min(10).max(1000).optional(),

  /** Concurrent sub-agent cap. Daemon default is 3. */
  max_parallel_subagents: z.number().int().positive().max(32).optional(),

  /** Daemon node IDs this agent is allowed to run on. Empty = any. */
  allowed_nodes: z.array(z.string().min(1)).optional(),

  /** Enable MCP tool bridge (mcp_call) for this agent. Default: false. */
  mcp_enabled: z.boolean().optional(),
  /** Whitelist of MCP server names (matches lib/mcp/builtin servers). */
  mcp_servers: z.array(z.string().min(1)).optional(),

  /**
   * Outbound egress allowlist, glob syntax (e.g., "*.npmjs.org").
   * Empty = unrestricted when sandbox network is on.
   */
  egress_allowlist: z.array(z.string().min(1)).optional(),

  /**
   * Use agent-specific L0 rules (sourced from the agentL0Rules table
   * with agentId == this agent's name) in addition to global presets.
   * Default: false (use daemon DefaultPresets only).
   */
  custom_l0_rules: z.boolean().optional(),

  /**
   * How the agent picks which tools to expose to the LLM per step.
   *
   * - 'all' (legacy): always expose every registered tool. Maximum
   *   capability, but every tool's full JSON schema is paid for on
   *   every turn — even simple chat pays for the ~3.5k-token sandbox
   *   schema it will never invoke.
   * - 'dynamic' (default): expose a small base set (memory / skill
   *   reads / task summary / scheduling) plus any tool family the
   *   user's latest input mentions, plus every tool called in a
   *   previous step of this run (historical dependency). Long inputs
   *   (>= 500 chars) or code-fenced inputs fall back to 'all' to
   *   avoid mis-routing complex tasks.
   *
   * Implemented via the SDK's per-step `activeTools` mechanism in
   * chatWorkflow's prepareStep. See lib/workflow/agent/tools/select.ts.
   */
  tool_selection_strategy: z.enum(['dynamic', 'all']).optional(),
});

export type AgentInstanceConfig = z.infer<typeof agentInstanceConfigSchema>;

/**
 * Agent registry configuration schema.
 */
export const agentConfigSchema = z.record(
  z.string().min(1, 'Agent name is required'),
  agentInstanceConfigSchema,
);

export type AgentConfig = z.infer<typeof agentConfigSchema>;
