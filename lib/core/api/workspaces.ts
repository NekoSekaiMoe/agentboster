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
