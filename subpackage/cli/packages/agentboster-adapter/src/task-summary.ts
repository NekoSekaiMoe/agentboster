/**
 * Task summary client — reads and updates the Web-side task_summaries row
 * for a CLI session. Used by the CLI's local `task_progress` tool to keep
 * todo state in the same Postgres table the Web agent loop writes to.
 */

import type { AgentbosterAuth } from './auth.ts';

/** Mirrors lib/core/db/agentd.ts TaskSummaryRecord (subset the CLI needs). */
export interface TaskSummary {
  taskId: string;
  agentId: string;
  sessionId: string | null;
  status: 'active' | 'paused' | 'completed';
  progress: string | null;
  decisions: Array<{
    id: string;
    timestamp: string;
    description: string;
    reason: string;
    alternatives: string[];
  }>;
  pending: string[];
  knownIssues: string[];
  version: number;
  lastUpdated: string;
  createdAt: string;
}

export interface TaskSummaryResponse {
  ok: boolean;
  summary: TaskSummary | null;
  error?: string;
}

export interface TaskProgressDelta {
  progress?: string;
  pendingAdd?: string[];
  pendingDone?: string[];
  knownIssueAdd?: string[];
  knownIssueResolve?: string[];
  decision?: {
    description: string;
    reason: string;
    alternatives?: string[];
  };
}

function authHeaders(auth: AgentbosterAuth): Record<string, string> {
  return {
    authorization: `Bearer ${auth.token}`,
    cookie: `clawless-auth=${auth.token}`,
    'content-type': 'application/json',
  };
}

export async function fetchTaskSummary(
  auth: AgentbosterAuth,
  sessionId: string,
): Promise<TaskSummary | null> {
  const root = auth.url.replace(/\/$/, '');
  const response = await fetch(
    `${root}/api/cli/sessions/${encodeURIComponent(sessionId)}/task-summary`,
    { headers: authHeaders(auth) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as TaskSummaryResponse;
  return body.summary ?? null;
}

export async function patchTaskSummary(
  auth: AgentbosterAuth,
  sessionId: string,
  delta: TaskProgressDelta,
): Promise<TaskSummary | null> {
  const root = auth.url.replace(/\/$/, '');
  const response = await fetch(
    `${root}/api/cli/sessions/${encodeURIComponent(sessionId)}/task-summary`,
    {
      method: 'PATCH',
      headers: authHeaders(auth),
      body: JSON.stringify(delta),
    },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as TaskSummaryResponse;
  return body.summary ?? null;
}
