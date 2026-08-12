import { z } from 'zod';

import { parseWithFallback } from '@/lib/core/api/schema';

/**
 * Client-side workspace mutation helpers (PATCH / DELETE against
 * /api/workspaces/[id]). Shared by the workspaces settings section and
 * the workspace detail page so both surfaces parse errors identically.
 */

const itemResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      id: z.string(),
      ownerId: z.string().optional(),
      name: z.string(),
      preferredNodeId: z.string().nullable().optional(),
      nodeGeneration: z.number().optional(),
      isDefault: z.boolean().optional(),
      status: z.string().optional(),
      visibility: z.string().optional(),
      ownerName: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .nullable()
    .optional(),
  error: z.string().optional(),
});

/**
 * Read the server's structured error message off a failed item mutation,
 * falling back to a generic message when the body is missing or drifted.
 */
export async function readItemError(
  res: Response,
  fallback: string,
): Promise<Error> {
  const payload = parseWithFallback(
    await res.json().catch(() => ({})),
    itemResponseSchema,
    { success: false, data: null } as z.infer<typeof itemResponseSchema>,
    { endpoint: 'workspaces mutation (error path)' },
  );
  return new Error(payload.error ?? fallback);
}

export async function patchWorkspace(
  id: string,
  body:
    | { action: 'rename'; name: string }
    | { action: 'set_default' }
    | { action: 'migrate_node'; newNodeId?: string }
    | { action: 'set_visibility'; visibility: 'private' | 'public' }
    | { action: 'set_shared_memory'; enabled: boolean },
): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readItemError(res, 'Failed to update workspace');
}

/** Response shape for the set_visibility action, which carries extra
 *  fields beyond the standard workspace row: the number of soft-quarantined
 *  shared-pool memories restored on a private→public flip, and the number
 *  of session_memories un-quarantined. Both are 0 for public→private and
 *  for private→public when no quarantine snapshot existed. Lenient schema
 *  (numbers optional, defaulting to 0) so an older backend that omits
 *  them still parses — the UI simply shows the generic success toast. */
const visibilityResponseSchema = itemResponseSchema.extend({
  restoredMemoryCount: z.number().optional().default(0),
  restoredSessionMemoryCount: z.number().optional().default(0),
});

export interface VisibilityChangeResult {
  restoredMemoryCount: number;
  restoredSessionMemoryCount: number;
}

/** Set a workspace's visibility and return the restore counts (0 when no
 *  soft-quarantined memories were restored, e.g. public→private or a
 *  private→public with no prior privatization). Use this instead of
 *  {@link patchWorkspace} when the caller wants to surface the restore
 *  count in a toast. */
export async function setWorkspaceVisibility(
  id: string,
  visibility: 'private' | 'public',
): Promise<VisibilityChangeResult> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set_visibility', visibility }),
  });
  if (!res.ok) throw await readItemError(res, 'Failed to update workspace');
  const payload = parseWithFallback(
    await res.json().catch(() => ({})),
    visibilityResponseSchema,
    {
      success: false,
      data: null,
      restoredMemoryCount: 0,
      restoredSessionMemoryCount: 0,
    } as z.infer<typeof visibilityResponseSchema>,
    { endpoint: 'workspaces set_visibility' },
  );
  return {
    restoredMemoryCount: payload.restoredMemoryCount ?? 0,
    restoredSessionMemoryCount: payload.restoredSessionMemoryCount ?? 0,
  };
}

export async function archiveWorkspaceRequest(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await readItemError(res, 'Failed to archive workspace');
}

/** Hard delete: removes the workspace + all sessions/messages/memories. */
export async function hardDeleteWorkspaceRequest(id: string): Promise<void> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(id)}?hard=true`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw await readItemError(res, 'Failed to delete workspace');
}
