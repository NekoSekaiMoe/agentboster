import { requestAgentd } from './agentd-http';
import { getAgentdClientConfig } from './agentd-tools-client';

/**
 * Server-side client for communicating with the Go Agent Daemon.
 * Uses mTLS + API key authentication.
 */

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

  const json = JSON.parse(response.text) as {
    success: boolean;
    data: T;
    error?: string;
  };
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
  await agentdRequest(
    'POST',
    `/api/v1/decisions/${decisionId}/resolve`,
    payload,
  );
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
