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

/**
 * Forward an L2 confirmation verdict to the daemon.
 *
 * `nodeId` (when present) is the id of the daemon that raised the
 * authorization, persisted on the decision. The verdict MUST land on
 * that same daemon — it holds the paused task and the L2AuthManager
 * cache — so we resolve the daemon URL from the node id rather than the
 * default `nodes[0]`/`AGENTD_URL` path. In a multi-node install the
 * default path would deliver the verdict to the wrong daemon and leave
 * the raising daemon's task hung until timeout.
 *
 * Backward compatible: when `nodeId` is absent (older decision rows that
 * predate node_id persistence, or single-node installs) or the node id
 * no longer resolves to a registered row, we fall back to the default
 * single-node resolution via `agentdRequest`.
 */
export async function forwardL2Confirm(payload: {
  task_id: string;
  decision_id: string;
  action: string;
  pattern?: string;
  duration?: string;
  nodeId?: string;
}): Promise<void> {
  const { nodeId, ...body } = payload;

  if (nodeId) {
    const { getAgentdClientConfigByNodeId } = await import(
      './agentd-tools-client'
    );
    const config = await getAgentdClientConfigByNodeId(nodeId);
    if (config) {
      const response = await requestAgentd(
        config,
        'POST',
        '/api/v1/l2-confirm',
        body,
      );
      if (!response.ok) {
        throw new Error(
          `AgentDaemon request failed: POST /api/v1/l2-confirm → ${response.status}: ${response.text}`,
        );
      }
      const json = JSON.parse(response.text) as {
        success: boolean;
        error?: string;
      };
      if (!json.success) {
        throw new Error(`AgentDaemon error: ${json.error ?? 'unknown'}`);
      }
      return;
    }
    // node id no longer resolves — fall through to default resolution.
  }

  await agentdRequest('POST', '/api/v1/l2-confirm', body);
}

/** Health check for the daemon. */
export async function daemonHealthCheck(): Promise<{
  status: string;
  version: string;
  uptime: string;
}> {
  return agentdRequest('GET', '/health');
}
