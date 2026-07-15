import { createLogger } from '@/lib/utils/logger';
import { getConfig as getAppConfig } from '@/lib/core/kv/config';
import { requestAgentd } from './agentd-http';
import type { AgentdHttpConfig } from './agentd-http';
import {
  resolveAgentdNodeUrl,
  resolveAgentdNodeUrlWithReason,
  resolveDefaultAgentdBaseUrl,
} from './agentd-url';

const logger = createLogger('agentd-tools-client');

interface AgentdToolExecRequest {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface AgentdToolExecResponse {
  success: boolean;
  data?: {
    success: boolean;
    data?: string;
    error?: string;
  };
  error?: string;
}

export async function getAgentdClientConfig(): Promise<AgentdHttpConfig> {
  'use step';
  const appConfig = await getAppConfig();
  const nodes = appConfig.agentd?.nodes ?? [];
  const baseUrl = resolveDefaultAgentdBaseUrl(nodes, process.env.AGENTD_URL);
  if (!baseUrl) {
    throw new Error('Agent Daemon URL is not configured');
  }
  return buildAgentdHttpConfig(baseUrl);
}

/**
 * Resolve an AgentdHttpConfig for a specific node, using the same
 * precedence as `execToolOnAgentd` (`resolveAgentdNodeUrl`): exact
 * configured match → single configured URL → AGENTD_URL → registered
 * ip:port fallback.
 *
 * Used by health checks that need to probe the same node that the
 * dispatch path would actually target, instead of always hitting
 * `nodes[0]`. Multi-node installs where `nodes[0]` points at a
 * different daemon than the one selected by `selectBestNode` would
 * otherwise produce misleading health verdicts.
 */
export async function getAgentdClientConfigForNode(
  nodeId: string,
  fallbackUrl: string,
): Promise<AgentdHttpConfig> {
  'use step';
  const appConfig = await getAppConfig();
  const configuredNodes = appConfig.agentd?.nodes ?? [];
  const baseUrl = resolveAgentdNodeUrl({
    configuredNodes,
    nodeId,
    envUrl: process.env.AGENTD_URL,
    fallbackUrl,
  });
  return buildAgentdHttpConfig(baseUrl);
}

/**
 * Identity of the agentd node a tool call actually ran on. Attached to
 * `execToolOnAgentd`'s result so callers (and, ultimately, the chat
 * tool card) can show *which* machine executed the call rather than an
 * opaque "agentd". `name` is the user-facing label from the dashboard
 * `agentd.nodes[].name` config when present; it is optional because
 * most single-node self-host installs never set it, in which case the
 * card falls back to the id/ip.
 */
export interface ExecutedAgentdNode {
  id: string;
  name?: string;
  ip: string;
}

/**
 * Execute a tool on the Agent Daemon synchronously.
 * This is the primary execution path when Agent Daemon is online.
 * Automatically selects the best available node based on resource availability,
 * or uses the specified nodeId if provided.
 */
export async function execToolOnAgentd(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  nodeId?: string,
  allowedNodes?: readonly string[],
): Promise<{
  success: boolean;
  data?: string;
  error?: string;
  node?: ExecutedAgentdNode;
}> {
  'use step';

  const { selectBestNode } = await import('@/lib/workflow/agent/dispatch');
  const { agentdNodes } = await import('@/lib/core/db/schema');
  const { db } = await import('@/lib/core/db');
  const { eq } = await import('drizzle-orm');

  let node: {
    nodeID: string;
    ip: string;
    port: number;
    sandboxes: string[];
    cpuUsage: number | null;
    memAvail: number | null;
    diskAvail: number | null;
    activeTasks: number;
    sandboxMemPeakTotal?: number | null;
  } | null = null;

  if (nodeId) {
    const rows = await db
      .select()
      .from(agentdNodes)
      .where(eq(agentdNodes.nodeID, nodeId))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`Node ${nodeId} not found`);
    }
    node = {
      nodeID: rows[0].nodeID,
      ip: rows[0].ip,
      port: rows[0].port,
      sandboxes: (rows[0].sandboxes as string[]) || [],
      cpuUsage: rows[0].cpuUsage,
      memAvail: rows[0].memAvail,
      diskAvail: rows[0].diskAvail,
      activeTasks: rows[0].activeTasks || 0,
      sandboxMemPeakTotal: rows[0].sandboxMemPeakTotal,
    };
  } else {
    // P3.1: pass per-agent allowedNodes filter to the node picker.
    node = await selectBestNode(undefined, allowedNodes);
  }

  if (!node) {
    throw new Error('No Agent Daemon nodes available');
  }

  // Resolve the daemon's reachable URL.
  //
  // `node.ip` / `node.port` are what the daemon itself reported at
  // registration time — typically a LAN address (e.g. 192.168.1.28).
  // When the Web runs on Vercel and the daemon sits behind a frp /
  // reverse-tunnel public entry, the LAN address is unreachable.
  //
  // The dashboard-configured `agentd.nodes[].url` is the public entry
  // point and takes precedence. Exact node-id matches win; a single
  // configured URL is treated as the default for single-node installs.
  // If no configured URL applies, fall back to `AGENTD_URL`, then to
  // raw `node.ip:port` (works only when the Web can actually reach the
  // daemon on its LAN IP, e.g. self-hosted Web on the same network).
  //
  // The protocol comes from the configured URL (http or https) rather
  // than being hardcoded, because the daemon may legitimately run
  // plain HTTP behind a TLS-terminating frp proxy.
  const appConfig = await getAppConfig();
  const configuredNodes = appConfig.agentd?.nodes ?? [];
  const nodeUrlResolution = resolveAgentdNodeUrlWithReason({
    configuredNodes,
    nodeId: node.nodeID,
    envUrl: process.env.AGENTD_URL,
    fallbackUrl: `http://${node.ip}:${node.port}`,
  });
  if (
    nodeUrlResolution.usableConfiguredUrlCount > 1 &&
    (nodeUrlResolution.reason === 'env' ||
      nodeUrlResolution.reason === 'registered-fallback')
  ) {
    logger.warn('agentd configured URL did not match selected node', {
      nodeId: node.nodeID,
      configuredUrlCount: nodeUrlResolution.usableConfiguredUrlCount,
      fallbackReason: nodeUrlResolution.reason,
    });
  }
  const nodeUrl = nodeUrlResolution.url;

  const config = await buildAgentdHttpConfig(nodeUrl);
  const req: AgentdToolExecRequest = {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
  };

  logger.info('Executing tool on Agent Daemon', {
    sessionId,
    toolName,
    nodeId: node.nodeID,
    nodeIp: node.ip,
    cpuUsage: node.cpuUsage,
    memAvail: node.memAvail,
    selectedBy: nodeId ? 'explicit' : 'auto',
  });

  // User-facing node label from dashboard config (agentd.nodes[].name),
  // matched by the same node id. Optional — falls back to id/ip in the UI.
  const configuredName = configuredNodes.find(
    (n) => n.id === node.nodeID,
  )?.name;
  const executedNode: ExecutedAgentdNode = {
    id: node.nodeID,
    name: configuredName,
    ip: node.ip,
  };

  const result = await dispatchToolToAgentd(config, req);
  return { ...result, node: executedNode };
}

/**
 * Build an AgentdHttpConfig from a base URL, attaching the mTLS client
 * cert/key and CA from the `AGENTD_*_PATH` env vars when present. This
 * is the credential-bearing half of an agentd dispatch; only ever call
 * it from server-side code that is allowed to hold agentd secrets.
 *
 * Not marked `'use step'` so route handlers (which are not workflow
 * steps) can reuse it.
 */
export async function buildAgentdHttpConfig(
  baseUrl: string,
): Promise<AgentdHttpConfig> {
  const config: AgentdHttpConfig = {
    baseUrl,
    apiKey: process.env.AGENTD_API_KEY ?? '',
  };

  if (
    process.env.AGENTD_CLIENT_CERT_PATH &&
    process.env.AGENTD_CLIENT_KEY_PATH
  ) {
    const { readFileSync } = await import('node:fs');
    config.cert = readFileSync(process.env.AGENTD_CLIENT_CERT_PATH);
    config.key = readFileSync(process.env.AGENTD_CLIENT_KEY_PATH);
  }

  if (process.env.AGENTD_CA_PATH) {
    const { readFileSync } = await import('node:fs');
    config.ca = readFileSync(process.env.AGENTD_CA_PATH);
  }

  return config;
}

/**
 * POST /api/v1/tools/exec to a specific agentd node and unpack the
 * envelope. Not workflow-bound; used by both the step wrapper above
 * (via the URL-resolution path) and the `/api/cli/exec-on-agentd`
 * route handler. Throws on HTTP failure or envelope `success=false`.
 */
export async function dispatchToolToAgentd(
  config: AgentdHttpConfig,
  req: AgentdToolExecRequest,
): Promise<{ success: boolean; data?: string; error?: string }> {
  const response = await requestAgentd(
    config,
    'POST',
    '/api/v1/tools/exec',
    req,
  );

  if (!response.ok) {
    throw new Error(
      `AgentDaemon tool exec failed: ${response.status}: ${response.text}`,
    );
  }

  const resp = JSON.parse(response.text) as AgentdToolExecResponse;

  if (!resp.success) {
    throw new Error(`AgentDaemon tool exec failed: ${resp.error}`);
  }

  return resp.data ?? { success: true };
}

/**
 * Check if Agent Daemon is healthy.
 *
 * Without `node`, probes the default endpoint (`nodes[0]` →
 * `AGENTD_URL`). Pass `node` to probe the same node the dispatch
 * path would target — `isAgentdAvailable` does this so a multi-node
 * install does not return a verdict driven by `nodes[0]`.
 */
export async function checkAgentdHealth(node?: {
  nodeID: string;
  ip: string;
  port: number;
}): Promise<boolean> {
  'use step';
  try {
    const config = node
      ? await getAgentdClientConfigForNode(
          node.nodeID,
          `http://${node.ip}:${node.port}`,
        )
      : await getAgentdClientConfig();
    const response = await requestAgentd(
      config,
      'GET',
      '/health',
      undefined,
      5000,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get Agent Daemon health info.
 *
 * Same node-vs-default semantics as `checkAgentdHealth`. The
 * `/api/agentd/v1/health` route uses the default form to preserve
 * its single-daemon diagnostic view for the WebUI; callers that
 * know which node they care about should pass it explicitly.
 */
export async function getAgentdHealth(node?: {
  nodeID: string;
  ip: string;
  port: number;
}): Promise<{
  status: string;
  version: string;
  uptime: string;
} | null> {
  'use step';
  try {
    const config = node
      ? await getAgentdClientConfigForNode(
          node.nodeID,
          `http://${node.ip}:${node.port}`,
        )
      : await getAgentdClientConfig();
    const response = await requestAgentd(
      config,
      'GET',
      '/health',
      undefined,
      5000,
    );
    if (!response.ok) return null;
    const data = JSON.parse(response.text);
    return data.data ?? null;
  } catch {
    return null;
  }
}

export async function abortAgentdSession(sessionId: string): Promise<boolean> {
  'use step';
  try {
    const config = await getAgentdClientConfig();
    const response = await requestAgentd(
      config,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/abort`,
    );
    return response.ok;
  } catch {
    return false;
  }
}
