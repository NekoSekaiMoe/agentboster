'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n } from '@/components/i18n-provider';
import { useConfigContext } from '@/components/config/config-provider';
import { parseWithFallback } from '@/lib/core/api/schema';
import { z } from 'zod';
import { ChevronsUpDown, Plus, Layers } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SESSION_LIST_KEY, useActiveWorkspace } from '@/hooks/use-session-list';

/**
 * Workspace wire shape returned by GET /api/workspaces. Kept lenient so a
 * drifted field still parses instead of white-screening the header.
 */
const workspaceSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  preferredNodeId: z.string().nullable().optional(),
  nodeGeneration: z.number().optional(),
  status: z.string().optional(),
});

const workspacesResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.array(workspaceSchema).optional(),
});

type WorkspaceListItem = z.infer<typeof workspaceSchema>;

/**
 * Workspace switcher for the chat header. Sits in the right-side gap-2
 * group, before the status dot. Switching the active workspace navigates
 * to a fresh chat root (so the session list re-loads under the new scope)
 * and invalidates the session list query.
 *
 * The list auto-ensures the user has at least one workspace (the GET
 * endpoint lazily creates a default), so the switcher always has something
 * to show.
 */
export function WorkspaceSwitcher() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const { workspaceId, setWorkspaceId } = useActiveWorkspace();
  // Include the current user in the query key so a user switch (login /
  // account change) does NOT reuse the previous user's cached workspace
  // list. The server route scopes by cookie-auth identity, so stale data
  // here would show another user's workspaces until staleTime (60s) expires.
  const configContext = useConfigContext();
  const currentUserId = configContext?.userId ?? null;

  const { data: workspaces = [], isLoading } = useQuery<WorkspaceListItem[]>({
    queryKey: ['workspaces', currentUserId],
    enabled: !!currentUserId,
    queryFn: async () => {
      const res = await fetch('/api/workspaces', { cache: 'no-store' });
      if (!res.ok) return [];
      const payload = parseWithFallback(
        await res.json(),
        workspacesResponseSchema,
        { success: false, data: [] },
        { endpoint: 'GET /api/workspaces' },
      );
      return payload.data ?? [];
    },
    staleTime: 60_000,
  });

  // Pick the active workspace: the stored one if it still exists, else the
  // first one (deterministic fallback so the UI never shows "no workspace").
  const active: WorkspaceListItem | undefined =
    workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  // Persist the resolved fallback. When the stored workspaceId is missing
  // (fresh login / cleared storage) or no longer exists in the loaded list
  // (deleted workspace, user switch), the store still holds the stale id
  // and the session list would query a scope the header is not showing.
  // Writing the resolved id through the shared store keeps header, sidebar,
  // and session list in agreement. Guards: never write during loading
  // (workspaces not yet known) and never write when the stored id already
  // matches (no render loop — after the write the effect re-runs and
  // no-ops). Effects never run during SSR, so this is server-safe.
  useEffect(() => {
    if (isLoading || workspaces.length === 0) return;
    const resolved =
      workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
    if (resolved.id !== workspaceId) {
      setWorkspaceId(resolved.id);
    }
  }, [isLoading, workspaces, workspaceId, setWorkspaceId]);

  async function handleSelect(id: string) {
    if (id === active?.id) return;
    setWorkspaceId(id);
    // Drop cached session lists (all workspaces) so the new scope refetches.
    await qc.invalidateQueries({ queryKey: SESSION_LIST_KEY });
    // Navigate to the chat root so no stale cross-workspace session stays
    // pinned in the message pane.
    router.push('/');
  }

  async function handleCreate() {
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t('workspace.defaultName') }),
      });
      if (!res.ok) throw new Error('create failed');
      const payload = parseWithFallback(
        await res.json(),
        z.object({
          success: z.boolean().optional(),
          data: workspaceSchema.optional(),
        }),
        { success: false, data: undefined } as {
          success?: boolean;
          data?: z.infer<typeof workspaceSchema>;
        },
        { endpoint: 'POST /api/workspaces' },
      );
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      if (payload.data) {
        await handleSelect(payload.data.id);
      }
      toast.success(t('workspace.createSuccess'));
    } catch {
      toast.error(t('workspace.createError'));
    }
  }

  if (isLoading || !active) {
    // Reserve layout space while loading; never collapse the header.
    return (
      <div className="flex size-5 items-center justify-center">
        <Layers className="size-3.5 text-muted-foreground/50" />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground"
              aria-label={t('workspace.switch')}
            >
              <Layers className="size-3.5" />
              <span className="max-w-[120px] truncate">{active.name}</span>
              <ChevronsUpDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('workspace.switch')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {t('workspace.label')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onClick={() => handleSelect(w.id)}
            className={
              w.id === active.id ? 'bg-accent text-accent-foreground' : ''
            }
          >
            <span className="flex-1 truncate">{w.name}</span>
            {w.id === active.id && (
              <span className="text-xs opacity-60">✓</span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCreate}>
          <Plus className="mr-2 size-3.5" />
          {t('workspace.createNew')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
