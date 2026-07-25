/**
 * Remote orchestration plan API client for the Agentboster web backend.
 *
 * Mirrors the Web ServerActions (app/(orchestration)/actions.ts) but over the
 * CLI Bearer-token API (app/api/cli/sessions/[id]/orchestration/plans/**). The
 * plan is fully user-authored client-side (list / create / add items / submit)
 * and persisted in the Web DB — the CLI never holds plan state locally.
 *
 * Submission is a two-step from the CLI's perspective:
 *   1. submitRemotePlan() marks the plan submitted server-side and returns
 *      the synthesized fan-out instruction text.
 *   2. The caller POSTs that instruction to /api/cli/chat as a normal user
 *      message, which drives the main agent to invoke its subAgent tool per
 *      the plan's waves. This is identical to how the Web chat UI submits.
 *
 * Used by the CLI `/orchestration` / `/plan` surface (TUI plan editor) and
 * available to Desktop (which calls through the CLI binary).
 */

import { getStoredAuth, type AgentbosterAuth } from '@agentboster/adapter';

// ---------------------------------------------------------------------------
// Types — mirror the server DAL shapes (lib/core/db/schema/agent-orchestration-plans.ts)
// ---------------------------------------------------------------------------

export interface RemotePlanItem {
  id: string;
  planId: string; // uuid PK on items table (FK to plans.id)
  itemId: string; // stable text id (item-xxx)
  agentName: string;
  task: string;
  dependsOn: string[];
  order: number;
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemotePlan {
  id: string; // uuid PK
  planId: string; // stable text id (plan-xxx)
  sessionId: string;
  title: string;
  description: string | null;
  status: 'draft' | 'submitted' | 'archived';
  submittedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  items?: RemotePlanItem[]; // present on GET single plan, absent on list
}

interface ApiEnvelope {
  ok: boolean;
  error?: string;
  // Payload fields (plans / plan / item / instruction / ...) are merged in
  // per-endpoint via the intersection type at each call site.
  [key: string]: unknown;
}

type Envelope<T> = ApiEnvelope & T;

function authHeaders(auth: AgentbosterAuth): Record<string, string> {
  return {
    authorization: `Bearer ${auth.token}`,
    cookie: `clawless-auth=${auth.token}`,
  };
}

function root(auth: AgentbosterAuth): string {
  return auth.url.replace(/\/$/, '');
}

function plansBase(auth: AgentbosterAuth, sessionId: string): string {
  return `${root(auth)}/api/cli/sessions/${encodeURIComponent(sessionId)}/orchestration/plans`;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}
// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

export async function listRemotePlans(
  auth: AgentbosterAuth,
  sessionId: string,
): Promise<RemotePlan[]> {
  const res = await fetch(plansBase(auth, sessionId), {
    headers: authHeaders(auth),
  });
  if (!res.ok) return [];
  const data = await readJson<Envelope<{ plans?: RemotePlan[] }>>(res);
  return data.plans ?? [];
}

export async function createRemotePlan(
  auth: AgentbosterAuth,
  sessionId: string,
  input: { title: string; description?: string | null },
): Promise<RemotePlan> {
  const res = await fetch(plansBase(auth, sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(input),
  });
  const data = await readJson<Envelope<{ plan?: RemotePlan }>>(res);
  if (!res.ok || !data.ok || !data.plan) {
    throw new Error(data.error ?? `Create failed (HTTP ${res.status})`);
  }
  return data.plan;
}

export async function getRemotePlan(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
): Promise<RemotePlan | null> {
  const res = await fetch(`${plansBase(auth, sessionId)}/${planId}`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) return null;
  const data = await readJson<Envelope<{ plan?: RemotePlan }>>(res);
  return data.plan ?? null;
}

export async function patchRemotePlan(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
  patch: { title?: string; description?: string | null },
): Promise<RemotePlan | null> {
  const res = await fetch(`${plansBase(auth, sessionId)}/${planId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  const data = await readJson<Envelope<{ plan?: RemotePlan }>>(res);
  return data.plan ?? null;
}

export async function archiveRemotePlan(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
): Promise<boolean> {
  const res = await fetch(`${plansBase(auth, sessionId)}/${planId}`, {
    method: 'DELETE',
    headers: authHeaders(auth),
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Plan items
// ---------------------------------------------------------------------------

export async function addRemotePlanItem(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
  input: {
    agentName: string;
    task: string;
    dependsOn?: string[];
    order?: number;
  },
): Promise<RemotePlanItem> {
  const res = await fetch(`${plansBase(auth, sessionId)}/${planId}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(input),
  });
  const data = await readJson<Envelope<{ item?: RemotePlanItem }>>(res);
  if (!res.ok || !data.ok || !data.item) {
    throw new Error(data.error ?? `Add item failed (HTTP ${res.status})`);
  }
  return data.item;
}

export async function patchRemotePlanItem(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
  itemId: string,
  patch: Partial<{
    agentName: string;
    task: string;
    dependsOn: string[];
    order: number;
  }>,
): Promise<RemotePlanItem | null> {
  const res = await fetch(
    `${plansBase(auth, sessionId)}/${planId}/items/${itemId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(auth) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) return null;
  const data = await readJson<Envelope<{ item?: RemotePlanItem }>>(res);
  return data.item ?? null;
}

export async function removeRemotePlanItem(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
  itemId: string,
): Promise<boolean> {
  const res = await fetch(
    `${plansBase(auth, sessionId)}/${planId}/items/${itemId}`,
    {
      method: 'DELETE',
      headers: authHeaders(auth),
    },
  );
  return res.ok;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Mark a plan submitted and return the synthesized fan-out instruction text.
 *
 * IMPORTANT: this does NOT send the instruction into the chat. The caller
 * must take the returned `instruction` and POST it to /api/cli/chat as a
 * normal user message — that is what actually triggers the main agent to
 * fan the plan out via its subAgent tool. Mirrors the Web submitPlanAction
 * contract exactly (Web returns instruction to the chat UI; CLI returns it
 * to the caller here).
 */
export async function submitRemotePlan(
  auth: AgentbosterAuth,
  sessionId: string,
  planId: string,
): Promise<{ instruction: string; sessionId: string }> {
  const res = await fetch(`${plansBase(auth, sessionId)}/${planId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify({}),
  });
  const data =
    await readJson<Envelope<{ instruction?: string; sessionId?: string }>>(res);
  if (!res.ok || !data.ok || !data.instruction) {
    throw new Error(data.error ?? `Submit failed (HTTP ${res.status})`);
  }
  return {
    instruction: data.instruction,
    sessionId: data.sessionId ?? sessionId,
  };
}

// ---------------------------------------------------------------------------
// Convenience: read using the current device's stored auth.
// ---------------------------------------------------------------------------

export async function listMyRemotePlans(
  sessionId: string,
): Promise<RemotePlan[]> {
  const auth = getStoredAuth();
  if (!auth) return [];
  return listRemotePlans(auth, sessionId);
}
