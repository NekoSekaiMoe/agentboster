'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Archive,
  Loader2,
  ServerCrash,
  Star,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { WorkspaceSessionsTable } from '@/components/config/sections/workspace-sessions-table';
import {
  archiveWorkspaceRequest,
  hardDeleteWorkspaceRequest,
  patchWorkspace,
} from '@/lib/core/api/workspaces';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { parseWithFallback } from '@/lib/core/api/schema';

/**
 * Workspace detail page (/config/workspaces/[id]).
 *
 * Read surface for the deeper workspace state the list view can't show:
 * bound node health, derived container status, node_generation (fencing
 * token), and recent failover history. The danger zone holds the two
 * state-changing operations: manual node migration (clears the binding +
 * bumps generation — the same end state as automatic failover) and
 * archive (soft delete; blocked for the default workspace).
 */

const failoverSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const detailResponseSchema = z.object({
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
      sharedMemoryEnabled: z.boolean().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      node: z
        .object({
          nodeId: z.string(),
          status: z.string(),
          lastHeartbeat: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      containerStatus: z.string().optional(),
      recentFailovers: z.array(failoverSchema).optional(),
    })
    .nullable()
    .optional(),
});

type WorkspaceDetailData = NonNullable<
  z.infer<typeof detailResponseSchema>['data']
>;

async function fetchWorkspaceDetail(id: string): Promise<WorkspaceDetailData> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to load workspace');
  const payload = parseWithFallback(
    await res.json(),
    detailResponseSchema,
    { success: false, data: null },
    { endpoint: 'GET /api/workspaces/[id]' },
  );
  if (!payload.data) throw new Error('Workspace not found');
  return payload.data;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function WorkspaceDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState('');
  const [sharedMemoryDisableOpen, setSharedMemoryDisableOpen] = useState(false);

  const {
    data: ws,
    isLoading,
    isError,
  } = useQuery<WorkspaceDetailData>({
    queryKey: ['workspace', id],
    queryFn: () => fetchWorkspaceDetail(id),
    staleTime: 15_000,
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['workspace', id] });
    await qc.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const migrateMutation = useMutation({
    // No newNodeId: clears the binding and bumps node_generation — the
    // next task lazily re-creates the container on a healthy node, and any
    // stale container on the old node fences itself out.
    mutationFn: () => patchWorkspace(id, { action: 'migrate_node' }),
    onSuccess: async () => {
      await invalidate();
      setMigrateOpen(false);
      toast.success(t('workspace.detail.migrateSuccess'));
    },
    onError: () => {
      setMigrateOpen(false);
      toast.error(t('workspace.detail.migrateError'));
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveWorkspaceRequest(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('workspace.archiveSuccess'));
      router.push('/config/workspaces');
    },
    onError: (error) => {
      setArchiveOpen(false);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('workspace.archiveError'),
      );
    },
  });

  const hardDeleteMutation = useMutation({
    mutationFn: () => hardDeleteWorkspaceRequest(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('workspace.detail.hardDeleteSuccess'));
      router.push('/config/workspaces');
    },
    onError: (error) => {
      setHardDeleteOpen(false);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('workspace.detail.hardDeleteError'),
      );
    },
  });

  const sharedMemoryMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      patchWorkspace(id, { action: 'set_shared_memory', enabled }),
    onSuccess: async () => {
      await invalidate();
      setSharedMemoryDisableOpen(false);
      toast.success(t('workspace.detail.sharedMemorySuccess'));
    },
    onError: (error) => {
      setSharedMemoryDisableOpen(false);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('workspace.detail.sharedMemoryError'),
      );
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !ws) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Link
          href="/config/workspaces"
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:underline"
        >
          <ArrowLeft className="size-4" />
          {t('workspace.detail.back')}
        </Link>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t('workspace.detail.notFound')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const isArchived = ws.status === 'archived';
  const containerStatusLabel =
    ws.containerStatus === 'not_created'
      ? t('workspace.container.notCreated')
      : ws.containerStatus === 'unreachable'
        ? t('workspace.container.unreachable')
        : t('workspace.container.unknown');

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="space-y-2">
        <Link
          href="/config/workspaces"
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:underline"
        >
          <ArrowLeft className="size-4" />
          {t('workspace.detail.back')}
        </Link>
        <div className="flex items-center gap-2">
          {ws.isDefault ? (
            <Star className="size-5 fill-amber-400 text-amber-400" />
          ) : null}
          <h1 className="font-semibold text-2xl tracking-tight">{ws.name}</h1>
          {ws.isDefault ? (
            <Badge variant="secondary">{t('workspace.defaultBadge')}</Badge>
          ) : null}
          <Badge variant={isArchived ? 'outline' : 'default'}>
            {isArchived
              ? t('workspace.detail.statusArchived')
              : t('workspace.detail.statusActive')}
          </Badge>
        </div>
      </div>

      {/* Basic info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('workspace.detail.basicInfo')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.name')}
            </span>
            <span>{ws.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.visibility')}
            </span>
            <span>
              {ws.visibility === 'public'
                ? t('workspace.publicBadge')
                : t('workspace.privateBadge')}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.createdAt')}
            </span>
            <span>{formatTime(ws.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.updatedAt')}
            </span>
            <span>{formatTime(ws.updatedAt)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Sharing (public workspaces): shared memory pool toggle */}
      {!isArchived && ws.visibility === 'public' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('workspace.detail.sharingTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-sm">
                  {t('workspace.detail.sharedMemoryTitle')}
                </div>
                <p className="text-muted-foreground text-xs">
                  {t('workspace.detail.sharedMemoryDescription')}
                </p>
              </div>
              <Button
                variant={ws.sharedMemoryEnabled ? 'default' : 'outline'}
                size="sm"
                disabled={sharedMemoryMutation.isPending}
                onClick={() => {
                  if (ws.sharedMemoryEnabled) {
                    // Turning the pool off DELETES it — confirm first.
                    setSharedMemoryDisableOpen(true);
                  } else {
                    sharedMemoryMutation.mutate(true);
                  }
                }}
              >
                {sharedMemoryMutation.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : null}
                {ws.sharedMemoryEnabled
                  ? t('workspace.detail.sharedMemoryOn')
                  : t('workspace.detail.sharedMemoryOff')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Sessions of this workspace */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('workspace.detail.sessionsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WorkspaceSessionsTable workspaceId={id} />
        </CardContent>
      </Card>

      {/* Container / node panel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('workspace.detail.containerStatus')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.containerStatus')}
            </span>
            <span>{containerStatusLabel}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.node')}
            </span>
            <span>
              {ws.preferredNodeId ?? t('workspace.nodeUnbound')}
              {ws.node ? (
                <Badge
                  variant={
                    ws.node.status === 'online' ? 'default' : 'destructive'
                  }
                  className="ml-2"
                >
                  {ws.node.status === 'online'
                    ? t('workspace.node.online')
                    : t('workspace.node.offline')}
                </Badge>
              ) : null}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.lastHeartbeat')}
            </span>
            <span>{formatTime(ws.node?.lastHeartbeat)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('workspace.detail.nodeGeneration')}
            </span>
            <span>{ws.nodeGeneration ?? '—'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Failover history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('workspace.detail.failoverHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {(ws.recentFailovers ?? []).length === 0 ? (
            <p className="text-muted-foreground">
              {t('workspace.detail.noFailovers')}
            </p>
          ) : (
            (ws.recentFailovers ?? []).map((failover) => {
              const payload = failover.payload ?? {};
              const title =
                typeof payload.title === 'string'
                  ? payload.title
                  : t('workspace.detail.failoverHistory');
              const summary =
                typeof payload.summary === 'string' ? payload.summary : null;
              return (
                <div key={failover.id} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{title}</span>
                    <span className="text-muted-foreground text-xs">
                      {formatTime(failover.createdAt)}
                    </span>
                  </div>
                  {summary ? (
                    <p className="text-muted-foreground text-xs">{summary}</p>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Danger zone */}
      {!isArchived ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <ServerCrash className="size-4" />
              {t('workspace.detail.dangerZone')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {ws.preferredNodeId ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium text-sm">
                    {t('workspace.detail.migrateTitle')}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t('workspace.detail.migrateDescription')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={migrateMutation.isPending}
                  onClick={() => setMigrateOpen(true)}
                >
                  {t('workspace.detail.migrateButton')}
                </Button>
              </div>
            ) : null}
            {ws.preferredNodeId ? <Separator /> : null}
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-sm">
                  {t('workspace.archive')}
                </div>
                <p className="text-muted-foreground text-xs">
                  {ws.isDefault
                    ? t('workspace.archiveDefaultBlocked')
                    : t('workspace.archiveConfirmDescription', {
                        name: ws.name,
                      })}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={ws.isDefault || archiveMutation.isPending}
                onClick={() => setArchiveOpen(true)}
              >
                <Archive className="mr-2 size-4" />
                {t('workspace.archive')}
              </Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-sm">
                  {t('workspace.detail.hardDeleteTitle')}
                </div>
                <p className="text-muted-foreground text-xs">
                  {ws.isDefault
                    ? t('workspace.archiveDefaultBlocked')
                    : t('workspace.detail.hardDeleteDescription')}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={ws.isDefault || hardDeleteMutation.isPending}
                onClick={() => {
                  setHardDeleteConfirm('');
                  setHardDeleteOpen(true);
                }}
              >
                <Trash2 className="mr-2 size-4" />
                {t('workspace.detail.hardDeleteButton')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Migrate confirmation */}
      <AlertDialog open={migrateOpen} onOpenChange={setMigrateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.detail.migrateTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.detail.migrateDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={migrateMutation.isPending}
              onClick={() => migrateMutation.mutate()}
            >
              {migrateMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.detail.migrateButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Shared-memory disable confirmation (pool deletion) */}
      <AlertDialog
        open={sharedMemoryDisableOpen}
        onOpenChange={setSharedMemoryDisableOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.detail.sharedMemoryDisableConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.detail.sharedMemoryDisableConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={sharedMemoryMutation.isPending}
              onClick={() => sharedMemoryMutation.mutate(false)}
            >
              {sharedMemoryMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.detail.sharedMemoryOff')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hard delete confirmation (type the workspace name) */}
      <AlertDialog
        open={hardDeleteOpen}
        onOpenChange={(open) => {
          if (!open) setHardDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.detail.hardDeleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.detail.hardDeleteConfirmDescription', {
                name: ws.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={hardDeleteConfirm}
            onChange={(event) => setHardDeleteConfirm(event.target.value)}
            placeholder={ws.name}
            aria-label={t('workspace.detail.hardDeleteConfirmInputLabel')}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                hardDeleteMutation.isPending ||
                hardDeleteConfirm.trim() !== ws.name
              }
              onClick={() => hardDeleteMutation.mutate()}
            >
              {hardDeleteMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.detail.hardDeleteButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive confirmation */}
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.archiveConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.archiveConfirmDescription', { name: ws.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate()}
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
