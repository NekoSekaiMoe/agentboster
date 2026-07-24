'use client';

import {
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  Loader2,
  RefreshCcw,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { listFilesAction } from '@/app/(files)/actions';
import type { FileRecord } from '@/app/(files)/actions';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspacePageHeader } from '@/components/workspace-page-header';
import { useI18n } from '@/components/i18n-provider';
import { FilePreviewPanel } from '@/components/file-preview-panel';

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function shortSessionId(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export default function FilesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<FileRecord[]>([]);
  const [sessionFilterInput, setSessionFilterInput] = useState('');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);

  const loadFirstPage = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await listFilesAction({
        sessionId: sessionFilter,
        limit: 30,
        sort: 'desc',
      });
      setItems(response.files ?? []);
      setHasMore(Boolean(response.hasMore));
      setNextBefore(response.nextBefore ?? null);
    } catch {
      toast.error(t('toast.file.listLoadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionFilter, t]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextBefore) {
      return;
    }

    setLoadingMore(true);
    try {
      const response = await listFilesAction({
        sessionId: sessionFilter,
        before: nextBefore,
        limit: 30,
        sort: 'desc',
      });
      const incoming = response.files ?? [];
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        const deduped = incoming.filter((item) => !seen.has(item.id));
        return [...current, ...deduped];
      });
      setHasMore(Boolean(response.hasMore));
      setNextBefore(response.nextBefore ?? null);
    } catch {
      toast.error(t('toast.file.listLoadMoreFailed'));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextBefore, sessionFilter, t]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const summary = useMemo(
    () => ({
      total: items.length,
      filter: sessionFilter,
    }),
    [items.length, sessionFilter],
  );

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background pb-16 md:pb-0">
      <WorkspacePageHeader
        title={t('form.label.files')}
        description="Browse sandbox exports and jump back to the related session."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void loadFirstPage()}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 size-4" />
            )}
            Refresh
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filter</CardTitle>
              <CardDescription>
                Default view shows files from all sessions.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="relative w-full md:max-w-md">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder={t('form.placeholder.filterBySessionId')}
                  value={sessionFilterInput}
                  onChange={(event) =>
                    setSessionFilterInput(event.target.value)
                  }
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    const value = sessionFilterInput.trim();
                    setSessionFilter(value.length > 0 ? value : null);
                  }}
                >
                  Apply
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSessionFilterInput('');
                    setSessionFilter(null);
                  }}
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="text-muted-foreground text-sm">
            {summary.filter
              ? `Showing ${summary.total} file(s) for session ${summary.filter}`
              : `Showing ${summary.total} file(s) from all sessions`}
          </div>

          {loading ? (
            <div className="grid gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={`skeleton-${i}`}>
                  <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <Skeleton className="size-4" />
                        <Skeleton className="h-4 w-48" />
                      </div>
                      <Skeleton className="h-3 w-64" />
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-3 w-32" />
                        <Skeleton className="h-3 w-28" />
                      </div>
                      <Skeleton className="h-3 w-40" />
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Skeleton className="h-8 w-24" />
                      <Skeleton className="h-8 w-28" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
              No exported files yet.
            </div>
          ) : (
            <div className="grid gap-3">
              {items.map((item) => (
                <Card key={item.id}>
                  <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <FileArchive className="size-4 text-muted-foreground" />
                        <p className="break-all font-medium text-sm">
                          {item.fileName}
                        </p>
                      </div>
                      <div className="break-all text-muted-foreground text-xs">
                        Source: {item.sourcePath}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
                        <span>Size: {formatBytes(item.size)}</span>
                        <span>MIME: {item.mimeType}</span>
                        <span>Created: {formatDate(item.createdAt)}</span>
                        <span>Session: {shortSessionId(item.sessionId)}</span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {item.sessionTitle
                          ? `Session title: ${item.sessionTitle}`
                          : `Channel: ${item.sessionChannel ?? 'unknown'}`}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setPreviewFile(item)}
                      >
                        <Eye className="mr-2 size-4" />
                        Preview
                      </Button>
                      <Button size="sm" variant="outline" asChild>
                        <a
                          href={`/api/files/${item.id}/download`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Download className="mr-2 size-4" />
                          Download
                        </a>
                      </Button>
                      <Button size="sm" asChild>
                        <Link href={`/chat/${item.sessionId}`}>
                          <ExternalLink className="mr-2 size-4" />
                          Open Session
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : null}
                Load More
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {previewFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPreviewFile(null)}
        >
          <div
            className="h-[85vh] w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            <FilePreviewPanel
              file={previewFile}
              onClose={() => setPreviewFile(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
