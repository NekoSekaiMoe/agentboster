import { createLogger } from '@/lib/utils/logger';
import { getConfig as getAppConfig } from '@/lib/core/kv/config';
import { requestAgentd } from './agentd-http';

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

interface AgentdClientConfig {
  baseUrl: string;
  apiKey: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  caPath?: string;
}

export async function getAgentdClientConfig(): Promise<AgentdClientConfig> {
  const appConfig = await getAppConfig();
  const configuredUrl = appConfig.agentd?.url?.trim();
  const baseUrl = configuredUrl || process.env.AGENTD_URL;
  const apiKey = process.env.AGENTD_API_KEY ?? '';
  if (!baseUrl) {
    throw new Error('Agent Daemon URL is not configured');
  }
  return {
    baseUrl,
    apiKey,
    clientCertPath: process.env.AGENTD_CLIENT_CERT_PATH,
    clientKeyPath: process.env.AGENTD_CLIENT_KEY_PATH,
    caPath: process.env.AGENTD_CA_PATH,
  };
}

async function agentdRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const config = await getAgentdClientConfig();
  const response = await requestAgentd(config, method, path, body);
  if (!response.ok) {
    throw new Error(
      `AgentDaemon request failed: ${method} ${path} → ${response.status}: ${response.text}`,
    );
  }
  return JSON.parse(response.text) as T;
}

/**
 * Execute a tool on the Agent Daemon synchronously.
 * This is the primary execution path when Agent Daemon is online.
 */
export async function execToolOnAgentd(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ success: boolean; data?: string; error?: string }> {
  const req: AgentdToolExecRequest = {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
  };
  logger.info('Executing tool on Agent Daemon', { sessionId, toolName });
  const resp = await agentdRequest<AgentdToolExecResponse>(
    'POST',
    '/api/v1/tools/exec',
    req,
  );
  if (!resp.success) {
    throw new Error(`AgentDaemon tool exec failed: ${resp.error}`);
  }
  return resp.data ?? { success: true };
}

/**
 * Check if Agent Daemon is healthy.
 */
export async function checkAgentdHealth(): Promise<boolean> {
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
  try {
    const response = await requestAgentd(
      await getAgentdClientConfig(),
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/abort`,
    );
    return response.ok;
  } catch {
    return false;
  }
}
