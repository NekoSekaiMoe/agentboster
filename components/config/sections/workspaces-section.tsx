'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ChevronRight,
  Globe,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { useConfigContext } from '@/components/config/config-provider';
import { useI18n } from '@/components/i18n-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  archiveWorkspaceRequest,
  patchWorkspace,
  readItemError,
} from '@/lib/core/api/workspaces';
import { parseWithFallback } from '@/lib/core/api/schema';

/**
 * Workspace management section (Settings → Workspaces).
 *
 * Per-owner CRUD over /api/workspaces + /api/workspaces/[id]. Shares the
 * ['workspaces', userId] query key with the chat-header switcher so both
 * views stay consistent on one invalidation. Node/container deep-dive
 * lives on the detail page (/config/workspaces/[id]); this list is the
 * CRUD surface only.
 */

/** Lenient wire shape — mirrors components/chat/workspace-switcher.tsx. */
const workspaceSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  name: z.string(),
  preferredNodeId: z.string().nullable().optional(),
  nodeGeneration: z.number().optional(),
  isDefault: z.boolean().optional(),
  status: z.string().optional(),
  /** Enriched by GET /api/workspaces (batched node-status join). */
  nodeStatus: z.string().nullable().optional(),
  containerStatus: z.string().optional(),
  visibility: z.string().optional(),
  /** Present only for OTHER users' public workspaces (shared entries). */
  ownerName: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const listResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.array(workspaceSchema).optional(),
});

export type WorkspaceListItem = z.infer<typeof workspaceSchema>;

/** Status dot mirroring the chat switcher (same derived semantics:
 *  green = bound & node online, red = unreachable, gray = unbound). */
function statusDotClass(containerStatus?: string): string {
  if (containerStatus === 'unreachable') return 'bg-red-500';
  if (containerStatus === 'unknown') return 'bg-green-500';
  return 'bg-muted-foreground/40';
}

async function fetchWorkspaces(): Promise<WorkspaceListItem[]> {
  const res = await fetch('/api/workspaces', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch workspaces');
  const payload = parseWithFallback(
    await res.json(),
    listResponseSchema,
    { success: false, data: [] },
    { endpoint: 'GET /api/workspaces' },
  );
  return payload.data ?? [];
}

async function createWorkspace(name: string): Promise<void> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await readItemError(res, 'Failed to create workspace');
}

export function WorkspacesSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const configContext = useConfigContext();
  const currentUserId = configContext?.userId ?? null;

  const [renameTarget, setRenameTarget] = useState<WorkspaceListItem | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceListItem | null>(
    null,
  );
  const [publicTarget, setPublicTarget] = useState<WorkspaceListItem | null>(
    null,
  );
  const [privateTarget, setPrivateTarget] = useState<WorkspaceListItem | null>(
    null,
  );

  const { data: workspaces = [], isLoading } = useQuery<WorkspaceListItem[]>({
    queryKey: ['workspaces', currentUserId],
    enabled: !!currentUserId,
    queryFn: fetchWorkspaces,
    staleTime: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workspaces'] });

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: async () => {
      await invalidate();
      toast.success(t('workspace.createSuccess'));
    },
    onError: () => toast.error(t('workspace.createError')),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      patchWorkspace(id, { action: 'rename', name }),
    onSuccess: async () => {
      await invalidate();
      setRenameTarget(null);
      toast.success(t('workspace.renameSuccess'));
    },
    onError: () => toast.error(t('workspace.renameError')),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => patchWorkspace(id, { action: 'set_default' }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('workspace.setDefaultSuccess'));
    },
    onError: () => toast.error(t('workspace.setDefaultError')),
  });

  const archiveMutation = useMutation({
    mutationFn: archiveWorkspaceRequest,
    onSuccess: async () => {
      await invalidate();
      setArchiveTarget(null);
      toast.success(t('workspace.archiveSuccess'));
    },
    onError: (error) => {
      setArchiveTarget(null);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('workspace.archiveError'),
      );
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: ({
      id,
      visibility,
    }: {
      id: string;
      visibility: 'private' | 'public';
    }) => patchWorkspace(id, { action: 'set_visibility', visibility }),
    onSuccess: async () => {
      await invalidate();
      setPublicTarget(null);
      setPrivateTarget(null);
      toast.success(t('workspace.visibilitySuccess'));
    },
    onError: () => {
      setPublicTarget(null);
      setPrivateTarget(null);
      toast.error(t('workspace.visibilityError'));
    },
  });

  const active = workspaces.filter((w) => w.status !== 'archived');
  const archived = workspaces.filter((w) => w.status === 'archived');

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderRow = (w: WorkspaceListItem, isArchived: boolean) => {
    const statusLabel =
      w.containerStatus === 'unreachable'
        ? t('workspace.node.offline')
        : w.containerStatus === 'unknown'
          ? t('workspace.container.unknown')
          : t('workspace.container.notCreated');
    // Shared by both non-archived branches (own workspace vs shared).
    const detailLink = (
      <Button variant="ghost" size="icon" asChild>
        <Link
          href={`/config/workspaces/${encodeURIComponent(w.id)}`}
          aria-label={t('workspace.detail.title')}
        >
          <ChevronRight className="size-4" />
        </Link>
      </Button>
    );
    return (
      <Card key={w.id} className={isArchived ? 'opacity-60' : undefined}>
        <CardContent className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                role="img"
                aria-label={statusLabel}
                className={`inline-block size-2 shrink-0 rounded-full ${statusDotClass(w.containerStatus)}`}
                title={statusLabel}
              />
              {w.isDefault ? (
                <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
              ) : null}
              <Link
                href={`/config/workspaces/${encodeURIComponent(w.id)}`}
                className="truncate font-medium hover:underline"
              >
                {w.name}
              </Link>
              {w.isDefault ? (
                <Badge variant="secondary">{t('workspace.defaultBadge')}</Badge>
              ) : null}
              {w.visibility === 'public' ? (
                <Badge variant="outline" className="gap-1">
                  <Globe className="size-3" />
                  {t('workspace.publicBadge')}
                </Badge>
              ) : null}
              {isArchived ? (
                <Badge variant="outline">{t('workspace.archived')}</Badge>
              ) : null}
            </div>
            <div className="mt-0.5 text-muted-foreground text-xs">
              {w.ownerName
                ? t('workspace.sharedBy', { name: w.ownerName })
                : w.preferredNodeId
                  ? t('workspace.nodeBound', { node: w.preferredNodeId })
                  : t('workspace.nodeUnbound')}
              {w.updatedAt
                ? ` · ${t('workspace.detail.updatedAt')}: ${new Date(w.updatedAt).toLocaleString()}`
                : ''}
            </div>
          </div>
          {!isArchived && w.ownerId === currentUserId ? (
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      w.visibility === 'public'
                        ? t('workspace.setPrivate')
                        : t('workspace.setPublic')
                    }
                    disabled={visibilityMutation.isPending}
                    onClick={() => {
                      if (w.visibility === 'public') {
                        // Going private deletes the shared memory pool and
                        // resets member-shared sessions — needs a confirm.
                        setPrivateTarget(w);
                      } else {
                        setPublicTarget(w);
                      }
                    }}
                  >
                    {w.visibility === 'public' ? (
                      <Lock className="size-4" />
                    ) : (
                      <Globe className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {w.visibility === 'public'
                    ? t('workspace.setPrivate')
                    : t('workspace.setPublic')}
                </TooltipContent>
              </Tooltip>
              {!w.isDefault ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('workspace.setDefault')}
                      disabled={setDefaultMutation.isPending}
                      onClick={() => setDefaultMutation.mutate(w.id)}
                    >
                      <Star className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('workspace.setDefault')}</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('workspace.rename')}
                    onClick={() => {
                      setRenameTarget(w);
                      setRenameValue(w.name);
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('workspace.rename')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('workspace.archive')}
                      disabled={w.isDefault || archiveMutation.isPending}
                      onClick={() => setArchiveTarget(w)}
                    >
                      <Archive className="size-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {w.isDefault
                    ? t('workspace.archiveDefaultBlocked')
                    : t('workspace.archive')}
                </TooltipContent>
              </Tooltip>
              {detailLink}
            </div>
          ) : !isArchived ? (
            <div className="flex shrink-0 items-center gap-1">{detailLink}</div>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {t('config.sections.workspaces.description')}
        </p>
        <Button
          size="sm"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate(t('workspace.defaultName'))}
        >
          {createMutation.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Plus className="mr-2 size-4" />
          )}
          {t('workspace.createNew')}
        </Button>
      </div>

      <div className="space-y-2">{active.map((w) => renderRow(w, false))}</div>

      {archived.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium text-muted-foreground text-sm">
            {t('workspace.archived')}
          </h3>
          {archived.map((w) => renderRow(w, true))}
        </div>
      ) : null}

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workspace.renameTitle')}</DialogTitle>
            <DialogDescription>{renameTarget?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="workspace-rename-input">
              {t('workspace.detail.name')}
            </Label>
            <Input
              id="workspace-rename-input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              disabled={renameMutation.isPending || !renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                renameMutation.mutate({
                  id: renameTarget.id,
                  name: renameValue.trim(),
                });
              }}
            >
              {renameMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Make-public confirmation */}
      <AlertDialog
        open={publicTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublicTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.publicConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.publicConfirmDescription', {
                name: publicTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={visibilityMutation.isPending}
              onClick={() => {
                if (!publicTarget) return;
                visibilityMutation.mutate({
                  id: publicTarget.id,
                  visibility: 'public',
                });
              }}
            >
              {visibilityMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.setPublic')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Make-private confirmation (shared pool deletion warning) */}
      <AlertDialog
        open={privateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPrivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.privateConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.privateConfirmDescription', {
                name: privateTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={visibilityMutation.isPending}
              onClick={() => {
                if (!privateTarget) return;
                visibilityMutation.mutate({
                  id: privateTarget.id,
                  visibility: 'private',
                });
              }}
            >
              {visibilityMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.setPrivate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive confirmation */}
      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.archiveConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.archiveConfirmDescription', {
                name: archiveTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (!archiveTarget) return;
                archiveMutation.mutate(archiveTarget.id);
              }}
            >
              {archiveMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
