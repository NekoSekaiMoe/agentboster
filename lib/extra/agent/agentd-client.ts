import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('agentd-client');

/**
 * Server-side client for communicating with the Go Agent Daemon.
 * Uses mTLS + API key authentication.
 */

interface AgentdClientConfig {
  baseUrl: string;
  apiKey: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  caPath?: string;
}

function getConfig(): AgentdClientConfig {
  const baseUrl = process.env.AGENTD_URL;
  const apiKey = process.env.AGENTD_API_KEY ?? '';

  if (!baseUrl) {
    throw new Error('AGENTD_URL environment variable is not set');
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
  const config = getConfig();
  const url = `${config.baseUrl}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  // In Node.js with mTLS, we may need to use a custom agent.
  // For now, rely on environment-level TLS configuration or
  // the daemon running on a reachable address.
  // If mTLS certs are configured, use Node.js https agent.
  if (config.clientCertPath && config.clientKeyPath) {
    try {
      const { Agent } = await import('node:https');
      const fs = await import('node:fs');
      const agentOptions: Record<string, unknown> = {
        cert: fs.readFileSync(config.clientCertPath),
        key: fs.readFileSync(config.clientKeyPath),
        rejectUnauthorized: true,
      };
      if (config.caPath) {
        agentOptions.ca = fs.readFileSync(config.caPath);
      }
      // @ts-expect-error - Node.js fetch supports agent option
      fetchOptions.agent = new Agent(agentOptions);
    } catch (err) {
      logger.warn('Failed to set up mTLS agent, proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    throw new Error(
      `AgentDaemon request failed: ${method} ${path} → ${response.status}: ${errorBody}`,
    );
  }

  const json = (await response.json()) as { success: boolean; data: T; error?: string };
  if (!json.success) {
    throw new Error(`AgentDaemon error: ${json.error ?? 'unknown'}`);
  }

  return json.data;
}

// ── Decision Queue API ─────────────────────────────────────────────

export interface DaemonDecision {
  decision_id: string;
  type: 'l2_auth' | 'question';
  task_id: string;
  session_id: string;
  command?: string;
  score?: number;
  reason?: string;
  question?: string;
  options?: string[];
  prompts?: Array<{
    question: string;
    header?: string;
    options?: string[];
    multiple?: boolean;
  }>;
  status: string;
  channels: string[];
  created_at: string;
  timeout_at: string;
  resolved_at?: string;
  resolved_by?: string;
  action?: string;
  answers?: string[][];
}

/** List all pending decisions from the daemon. */
export async function listDecisions(): Promise<DaemonDecision[]> {
  return agentdRequest<DaemonDecision[]>('GET', '/api/v1/decisions');
}

/** Resolve a decision (L2 auth or question answer). */
export async function resolveDecision(
  decisionId: string,
  payload: {
    answers?: string[][];
    reply?: string;
    action?: string;
    time_input?: string;
    chat_id?: string;
    user_id?: string;
  },
): Promise<void> {
  await agentdRequest('POST', `/api/v1/decisions/${decisionId}/resolve`, payload);
}

/** Reject (dismiss) a question decision. */
export async function rejectDecision(decisionId: string): Promise<void> {
  await agentdRequest('POST', `/api/v1/decisions/${decisionId}/reject`);
}

/** Forward L2 confirmation to the daemon. */
export async function forwardL2Confirm(payload: {
  task_id: string;
  decision_id: string;
  action: string;
  pattern?: string;
  duration?: string;
}): Promise<void> {
  await agentdRequest('POST', '/api/v1/l2-confirm', payload);
}

/** Health check for the daemon. */
export async function daemonHealthCheck(): Promise<{
  status: string;
  version: string;
  uptime: string;
}> {
  return agentdRequest('GET', '/health');
}
