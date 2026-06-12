import { createLogger } from '@/lib/utils/logger';
import { getConfig as getAppConfig } from '@/lib/core/kv/config';
import { requestAgentd } from './agentd-http';
import type { AgentdHttpConfig } from './agentd-http';
import { readFileSync } from 'node:fs';

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
  const firstNodeUrl = nodes.length > 0 ? nodes[0].url : undefined;
  const baseUrl = firstNodeUrl || process.env.AGENTD_URL;
  const apiKey = process.env.AGENTD_API_KEY ?? '';
  if (!baseUrl) {
    throw new Error('Agent Daemon URL is not configured');
  }

  const config: AgentdHttpConfig = {
    baseUrl,
    apiKey,
  };

  if (
    process.env.AGENTD_CLIENT_CERT_PATH &&
    process.env.AGENTD_CLIENT_KEY_PATH
  ) {
    config.cert = readFileSync(process.env.AGENTD_CLIENT_CERT_PATH);
    config.key = readFileSync(process.env.AGENTD_CLIENT_KEY_PATH);
  }

  if (process.env.AGENTD_CA_PATH) {
    config.ca = readFileSync(process.env.AGENTD_CA_PATH);
  }

  return config;
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
): Promise<{ success: boolean; data?: string; error?: string }> {
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
    };
  } else {
    node = await selectBestNode();
  }

  if (!node) {
    throw new Error('No Agent Daemon nodes available');
  }

  const nodeUrl = `https://${node.ip}:${node.port}`;
  const apiKey = process.env.AGENTD_API_KEY ?? '';

  const config: AgentdHttpConfig = {
    baseUrl: nodeUrl,
    apiKey,
  };

  if (
    process.env.AGENTD_CLIENT_CERT_PATH &&
    process.env.AGENTD_CLIENT_KEY_PATH
  ) {
    config.cert = readFileSync(process.env.AGENTD_CLIENT_CERT_PATH);
    config.key = readFileSync(process.env.AGENTD_CLIENT_KEY_PATH);
  }

  if (process.env.AGENTD_CA_PATH) {
    config.ca = readFileSync(process.env.AGENTD_CA_PATH);
  }

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
 */
export async function checkAgentdHealth(): Promise<boolean> {
  'use step';
  try {
    const config = await getAgentdClientConfig();
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
 */
export async function getAgentdHealth(): Promise<{
  status: string;
  version: string;
  uptime: string;
} | null> {
  'use step';
  try {
    const config = await getAgentdClientConfig();
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
