'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Globe,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  deleteSessionAction,
  listRecentSessionsAction,
  setSessionVisibilityAction,
  updateSessionTitleAction,
} from '@/app/(chat)/actions';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  invalidateSessionListQuery,
  type SessionListItem,
} from '@/hooks/use-session-list';

/**
 * Sessions-of-a-workspace management table (workspace detail page).
 *
 * Rows come from the access-aware listRecentSessionsAction: the actor sees
 * their own sessions, shared sessions in public workspaces they can
 * access, and — when they manage the workspace — other members' PRIVATE
 * sessions annotated manageOnly (curate-only: rename/delete, never open).
 * Visibility toggling is creator-only (isOwn) by product decision.
 */

type SessionMutationErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unknown';

/**
 * Carries the structured error code returned by setSessionVisibilityAction
 * / deleteSessionAction through the react-query error channel so onError
 * can map it to a localized message (raw Error.message is redacted by
 * Next.js in production and must never be shown).
 */
class SessionMutationError extends Error {
  readonly code: SessionMutationErrorCode;

  constructor(code: SessionMutationErrorCode) {
    super(code);
    this.name = 'SessionMutationError';
    this.code = code;
  }
}

/**
 * Map a SessionMutationResult error code to a localized toast message.
 * Server actions return codes instead of throwing so we never surface
 * raw error.message (Next.js redacts it in production anyway).
 */
function sessionErrorMessage(
  t: ReturnType<typeof useI18n>['t'],
  code: SessionMutationErrorCode,
  fallback: string,
): string {
  switch (code) {
    case 'forbidden':
      return t('workspace.detail.sessionErrorForbidden');
    case 'not_found':
      return t('workspace.detail.sessionErrorNotFound');
    case 'invalid_input':
      return t('workspace.detail.sessionErrorInvalidInput');
    default:
      return fallback;
  }
}

export function WorkspaceSessionsTable({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { t } = useI18n();
  const configContext = useConfigContext();
  const currentUserId = configContext?.userId ?? null;

  const qc = useQueryClient();
  const [renameTarget, setRenameTarget] = useState<SessionListItem | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | null>(
    null,
  );

  // userId scopes the cache entry so an account switch can't show the
  // previous user's sessions (mirrors use-session-list.ts).
  const queryKey = ['workspace-sessions', currentUserId, workspaceId] as const;
  const { data: sessions = [], isLoading } = useQuery<SessionListItem[]>({
    queryKey,
    enabled: !!currentUserId,
    queryFn: () => listRecentSessionsAction({ workspaceId, limit: 100 }),
    staleTime: 10_000,
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey });
    invalidateSessionListQuery();
  };

  const visibilityMutation = useMutation({
    mutationFn: async ({
      id,
      visibility,
    }: {
      id: string;
      visibility: 'private' | 'shared';
    }) => {
      const result = await setSessionVisibilityAction({ id, visibility });
      if (!result.success) {
        throw new SessionMutationError(result.error);
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('workspace.detail.sessionVisibilitySuccess'));
    },
    onError: (error) => {
      toast.error(
        sessionErrorMessage(
          t,
          error instanceof SessionMutationError ? error.code : 'unknown',
          t('workspace.detail.sessionVisibilityError'),
        ),
      );
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string | null }) =>
      updateSessionTitleAction({ id, title }),
    onSuccess: async () => {
      await invalidate();
      setRenameTarget(null);
      toast.success(t('workspace.detail.sessionRenameSuccess'));
    },
    onError: () => {
      toast.error(t('workspace.detail.sessionRenameError'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await deleteSessionAction(id);
      if (!result.success) {
        throw new SessionMutationError(result.error);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setDeleteTarget(null);
      toast.success(t('workspace.detail.sessionDeleted'));
    },
    onError: (error) => {
      setDeleteTarget(null);
      toast.error(
        sessionErrorMessage(
          t,
          error instanceof SessionMutationError ? error.code : 'unknown',
          t('workspace.detail.sessionDeleteError'),
        ),
      );
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        {t('workspace.detail.sessionsEmpty')}
      </p>
    );
  }

  const busy =
    visibilityMutation.isPending ||
    renameMutation.isPending ||
    deleteMutation.isPending;

  return (
    <div className="space-y-1">
      {sessions.map((session) => {
        const shared = session.visibility === 'shared';
        return (
          <div
            key={session.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
          >
            {session.manageOnly ? (
              <Lock className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate text-sm">
              {session.title ?? t('workspace.detail.sessionUntitled')}
            </span>
            {shared ? (
              <Badge variant="secondary" className="shrink-0">
                <Globe className="mr-1 size-3" />
                {t('workspace.detail.sessionSharedBadge')}
              </Badge>
            ) : null}
            {session.manageOnly ? (
              <Badge variant="outline" className="shrink-0">
                {t('workspace.detail.sessionManageOnlyBadge')}
              </Badge>
            ) : null}
            <div className="flex shrink-0 items-center gap-1">
              {!session.manageOnly ? (
                <Button variant="ghost" size="icon" asChild>
                  <Link
                    href={`/chat/${session.id}`}
                    aria-label={t('workspace.detail.sessionOpen')}
                  >
                    <MessageSquare className="size-4" />
                  </Link>
                </Button>
              ) : null}
              {session.isOwn ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    shared
                      ? t('workspace.detail.sessionMakePrivate')
                      : t('workspace.detail.sessionMakeShared')
                  }
                  title={
                    shared
                      ? t('workspace.detail.sessionMakePrivate')
                      : t('workspace.detail.sessionMakeShared')
                  }
                  disabled={busy}
                  onClick={() =>
                    visibilityMutation.mutate({
                      id: session.id,
                      visibility: shared ? 'private' : 'shared',
                    })
                  }
                >
                  {shared ? (
                    <Lock className="size-4" />
                  ) : (
                    <Globe className="size-4" />
                  )}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('workspace.detail.sessionRenameTitle')}
                disabled={busy}
                onClick={() => {
                  setRenameValue(session.title ?? '');
                  setRenameTarget(session);
                }}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('workspace.detail.sessionDelete')}
                disabled={busy}
                onClick={() => setDeleteTarget(session)}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </div>
          </div>
        );
      })}

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('workspace.detail.sessionRenameTitle')}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder={t('workspace.detail.sessionRenamePlaceholder')}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={renameMutation.isPending}
              onClick={() => {
                if (!renameTarget) return;
                renameMutation.mutate({
                  id: renameTarget.id,
                  title: renameValue.trim() || null,
                });
              }}
            >
              {renameMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.detail.sessionDeleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.detail.sessionDeleteConfirmDescription', {
                title:
                  deleteTarget?.title ?? t('workspace.detail.sessionUntitled'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('workspace.detail.sessionDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
