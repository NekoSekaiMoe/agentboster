/**
 * Subagent query helpers for the CLI adapter.
 *
 * These functions call the web backend's proxy API routes which in turn
 * forward to agentd. They mirror the agentd response shapes so the
 * desktop and CLI TUI can consume them directly.
 */

export interface SubagentInfo {
  id: string;
  task: string;
  status: string;
  summary?: string;
  error?: string;
  session_id?: string;
  agent_id?: string;
  sandbox_type?: string;
}

export interface SubagentMessage {
  role: string;
  content: string;
  tool_name?: string;
  tool_input?: string;
  is_error?: boolean;
  timestamp: number;
}

export interface SubagentBatchInfo {
  batch_id: string;
  status: string;
  concurrency_limit?: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  jobs: SubagentInfo[];
}

async function fetchJson<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T | null> {
  const root = baseUrl.replace(/\/$/, '');
  try {
    const resp = await fetch(`${root}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `clawless-auth=${token}`,
      },
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { ok?: boolean; data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

export async function fetchSubagentInfo(
  baseUrl: string,
  token: string,
  subagentId: string,
): Promise<SubagentInfo | null> {
  return fetchJson<SubagentInfo>(
    baseUrl,
    token,
    `/api/cli/subagent/${subagentId}`,
  );
}

export async function fetchSubagentMessages(
  baseUrl: string,
  token: string,
  subagentId: string,
): Promise<SubagentMessage[]> {
  const msgs = await fetchJson<SubagentMessage[]>(
    baseUrl,
    token,
    `/api/cli/subagent/${subagentId}/messages`,
  );
  return msgs ?? [];
}

export async function fetchSubagentBatch(
  baseUrl: string,
  token: string,
  batchId: string,
): Promise<SubagentBatchInfo | null> {
  return fetchJson<SubagentBatchInfo>(
    baseUrl,
    token,
    `/api/cli/subagent-batch/${batchId}`,
  );
}

export function streamSubagentMessages(
  baseUrl: string,
  token: string,
  subagentId: string,
  onMessage: (messages: SubagentMessage[]) => void,
  intervalMs = 3000,
): { stop: () => void } {
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const msgs = await fetchSubagentMessages(baseUrl, token, subagentId);
        if (!stopped) onMessage(msgs);
      } catch {
        // silent poll failure
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void poll();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
