/**
 * Agent config endpoint (daemon → web).
 *
 * P1.1: agentd's clawless.Client.GetAgentConfig POSTs/GETs here to fetch
 * per-agent sandbox/resource/MCP settings. Previously this route didn't
 * exist so the daemon's GetAgentConfig always 404'd and call sites
 * passed nil to SelectSandbox. Now returns the assembled AgentConfig
 * JSON the daemon expects, sourced from the KV-stored agentInstanceConfig.
 *
 * The route is unauthenticated on the path level (called by the daemon
 * with mTLS + X-API-Key) but reuses the same path-shape as the rest of
 * /api/agentd/v1/* so middleware covers it.
 */

import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.agent-config');

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  try {
    const config = await getConfig();
    const agents = config.agents ?? {};
    const instance = agents[agentId];

    if (!instance) {
      // Not necessarily an error — many agents only exist as a row in
      // the DB sessions table without a KV record. Return the empty
      // defaults shape so the daemon falls back cleanly.
      logger.info('agent-config: no KV record, returning defaults', {
        agentId,
      });
      return Response.json({
        success: true,
        data: {
          agent_id: agentId,
          default_sandbox: '',
          available_sandboxes: [],
          max_parallel_sub_agents: 3,
          memory_enabled: true,
          mcp_enabled: false,
          mcp_servers: [],
          allowed_nodes: [],
          egress_allowlist: [],
          custom_l0_rules: false,
        },
      });
    }

    // Map the Web-side camelCase-ish fields into the daemon's snake_case
    // AgentConfig struct (clawless/types.go).
    const data = {
      agent_id: agentId,
      default_sandbox: instance.sandbox_type ?? '',
      available_sandboxes: instance.sandbox_type ? [instance.sandbox_type] : [],
      max_parallel_sub_agents: instance.max_parallel_subagents ?? 3,
      memory_enabled: true,
      // Sandbox resource knobs (P1.1)
      sandbox_cpu: instance.sandbox_cpu,
      sandbox_mem: instance.sandbox_mem,
      sandbox_pids: instance.sandbox_pids,
      sandbox_disk: instance.sandbox_disk,
      sandbox_blkio_weight: instance.sandbox_blkio_weight,
      // MCP (P1.2)
      mcp_enabled: instance.mcp_enabled ?? false,
      mcp_servers: instance.mcp_servers ?? [],
      // Multi-node filter (P3.1)
      allowed_nodes: instance.allowed_nodes ?? [],
      // Network egress (P2.2)
      egress_allowlist: instance.egress_allowlist ?? [],
      // L0 (P1.1)
      custom_l0_rules: instance.custom_l0_rules ?? false,
      // Path scoping (kept for forward compat with clawless.AgentConfig)
      allowed_paths: [],
      blocked_paths: [],
    };

    return Response.json({ success: true, data });
  } catch (error) {
    logger.error('agent-config failed', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Agent config fetch failed' },
      { status: 500 },
    );
  }
}

// Zod schema kept for future PATCH support; currently GET-only.
void z;
