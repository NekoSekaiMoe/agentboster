/**
 * Remote workspace client for the AgentBoster Web backend.
 *
 * Talks to `/api/workspaces` using the same authenticated channel as the
 * rest of the desktop app: the Bearer token + `clawless-auth` cookie read
 * from `~/.config/agentboster-cli/config.json` (see `agentboster-auth.ts`).
 * All responses are parsed defensively — no bare `as T` casts on response
 * JSON — so contract drift on the Web side degrades to skipped entries
 * instead of runtime crashes. A 2xx response that does not carry the
 * expected `{ success: true }` envelope is treated as a failure (not an
 * empty result) so a malformed body can never masquerade as "no
 * workspaces" and wipe the caller's cached list.
 */

import type { AgentbosterDesktopAuth } from './agentboster-auth.js';

export interface RemoteWorkspace {
  id: string;
  ownerId: string | null;
  ownerName: string | null;
  name: string;
  isDefault: boolean;
  status: string;
  visibility: string;
}

export type RemoteWorkspacePatchAction =
  | { action: 'rename'; name: string }
  | { action: 'set_default' }
  | { action: 'migrate_node'; newNodeId?: string }
  | { action: 'set_visibility'; visibility: 'private' | 'public' };

/**
 * HTTP-level failure (the server answered with a non-2xx status or a
 * `{ success: false }` envelope). Network failures surface as plain
 * TypeError from fetch instead, so callers can tell "server rejected"
 * apart from "backend unreachable".
 */
export class RemoteWorkspaceRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RemoteWorkspaceRequestError';
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function workspaceApiRoot(auth: AgentbosterDesktopAuth): string {
  return auth.url.replace(/\/+$/, '');
}

function workspaceAuthHeaders(
  auth: AgentbosterDesktopAuth,
  withJsonBody = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.token}`,
    cookie: `clawless-auth=${auth.token}`,
  };
  if (withJsonBody) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function extractErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  return asNonEmptyString(record.error) ?? fallback;
}

const REMOTE_FETCH_TIMEOUT_MS = 12_000;

/**
 * Shared fetch wrapper: every remote-workspace request gets a bounded
 * timeout so a hung connection cannot wedge the caller's await forever.
 * AbortSignal.timeout rejects with a TimeoutError (a DOMException), which
 * callers treat like any other network failure.
 */
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });
}

/**
 * Read the response body once and enforce the `{ success, data, error }`
 * envelope. Any 2xx response whose parsed body is not an object with
 * `success === true` is rejected: silently accepting a null/empty/missing
 * envelope would let callers fall back to an empty list and destroy local
 * state (e.g. the persisted remote-workspace cache).
 * Returns the raw body for further field extraction.
 */
async function readEnvelope(
  response: Response,
  actionLabel: string,
): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RemoteWorkspaceRequestError(
      response.status,
      extractErrorMessage(
        body,
        `Failed to ${actionLabel}: HTTP ${response.status}`,
      ),
    );
  }
  const record = asRecord(body);
  if (record.success !== true) {
    throw new RemoteWorkspaceRequestError(
      response.status,
      extractErrorMessage(
        record,
        `Failed to ${actionLabel}: malformed response envelope`,
      ),
    );
  }
  return body;
}

function normalizeRemoteWorkspace(value: unknown): RemoteWorkspace | null {
  const record = asRecord(value);
  const id = asNonEmptyString(record.id);
  if (!id) return null;
  return {
    id,
    ownerId: asNonEmptyString(record.ownerId),
    ownerName: asNonEmptyString(record.ownerName),
    name: asNonEmptyString(record.name) ?? 'Workspace',
    isDefault: record.isDefault === true,
    status: asNonEmptyString(record.status) ?? 'active',
    visibility: asNonEmptyString(record.visibility) ?? 'private',
  };
}

export async function fetchRemoteWorkspaces(
  auth: AgentbosterDesktopAuth,
): Promise<RemoteWorkspace[]> {
  const response = await fetchWithTimeout(
    `${workspaceApiRoot(auth)}/api/workspaces`,
    {
      headers: workspaceAuthHeaders(auth),
    },
  );
  const body = await readEnvelope(response, 'load workspaces');
  // The envelope guarantees `success === true`, but the list payload must
  // still be an array — a missing/non-array `data` field is contract drift
  // and must fail loudly rather than degrade to an empty list.
  const items = asRecord(body).data;
  if (!Array.isArray(items)) {
    throw new RemoteWorkspaceRequestError(
      response.status,
      'Failed to load workspaces: malformed response payload',
    );
  }
  return items
    .map((entry) => normalizeRemoteWorkspace(entry))
    .filter((entry): entry is RemoteWorkspace => Boolean(entry));
}

export async function createRemoteWorkspace(
  auth: AgentbosterDesktopAuth,
  name: string,
): Promise<RemoteWorkspace | null> {
  const response = await fetchWithTimeout(
    `${workspaceApiRoot(auth)}/api/workspaces`,
    {
      method: 'POST',
      headers: workspaceAuthHeaders(auth, true),
      body: JSON.stringify({ name }),
    },
  );
  const body = await readEnvelope(response, 'create workspace');
  return normalizeRemoteWorkspace(asRecord(body).data);
}

export async function patchRemoteWorkspace(
  auth: AgentbosterDesktopAuth,
  workspaceId: string,
  action: RemoteWorkspacePatchAction,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${workspaceApiRoot(auth)}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: 'PATCH',
      headers: workspaceAuthHeaders(auth, true),
      body: JSON.stringify(action),
    },
  );
  await readEnvelope(response, 'update workspace');
}

export async function archiveRemoteWorkspace(
  auth: AgentbosterDesktopAuth,
  workspaceId: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${workspaceApiRoot(auth)}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: 'DELETE',
      headers: workspaceAuthHeaders(auth),
    },
  );
  await readEnvelope(response, 'archive workspace');
}
