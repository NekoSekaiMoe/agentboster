import { createLogger } from '@/lib/utils/logger';

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
}

function getConfig(): AgentdClientConfig {
  const baseUrl = process.env.AGENTD_URL;
  const apiKey = process.env.AGENTD_API_KEY ?? '';
  if (!baseUrl) {
    throw new Error('AGENTD_URL environment variable is not set');
  }
  return { baseUrl, apiKey };
}

async function agentdRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = getConfig();
  const url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }
  const fetchOptions: RequestInit = { method, headers };
  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }
  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    throw new Error(`AgentDaemon request failed: ${method} ${path} → ${response.status}: ${errorBody}`);
  }
  return (await response.json()) as T;
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
  const resp = await agentdRequest<AgentdToolExecResponse>('POST', '/api/v1/tools/exec', req);
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
    const config = getConfig();
    const response = await fetch(`${config.baseUrl}/health`, {
      headers: config.apiKey ? { 'X-API-Key': config.apiKey } : {},
      signal: AbortSignal.timeout(5000),
    });
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
    const config = getConfig();
    const response = await fetch(`${config.baseUrl}/health`, {
      headers: config.apiKey ? { 'X-API-Key': config.apiKey } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data ?? null;
  } catch {
    return null;
  }
}
