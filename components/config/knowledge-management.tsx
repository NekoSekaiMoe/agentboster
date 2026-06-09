'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type KnowledgeVisibility = 'team' | 'private';

type KnowledgeBase = {
  id: string;
  agentId: string;
  ownerUserId: string | null;
  visibility: KnowledgeVisibility;
  priority: number;
  name: string;
  description: string | null;
  emoji: string;
  enabled: boolean;
  canManage?: boolean;
  updatedAt: string;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  sourceType: 'text' | 'file' | 'url' | 'import';
  sourceUri: string | null;
  createdAt: string;
};

type KnowledgeConnector = {
  id: string;
  provider: 'url';
  name: string;
  sourceUri: string;
  enabled: boolean;
  syncStatus: 'idle' | 'syncing' | 'failed';
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

type KnowledgeListResponse = {
  data: KnowledgeBase[];
  meta?: { isAdmin?: boolean };
};

async function readError(res: Response, fallback: string) {
  const payload = await res.json().catch(() => ({ error: fallback }));
  return payload?.error ?? fallback;
}

async function fetchKnowledgeBases(): Promise<KnowledgeListResponse> {
  const res = await fetch('/api/knowledge?include_disabled=true');
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to fetch knowledge bases'));
  }
  return res.json();
}

async function fetchKnowledgeDocuments(
  knowledgeBaseId: string,
): Promise<KnowledgeDocument[]> {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(knowledgeBaseId)}/documents`,
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to fetch documents'));
  }
  const payload = await res.json();
  return payload.data ?? [];
}

async function fetchKnowledgeConnectors(
  knowledgeBaseId: string,
): Promise<KnowledgeConnector[]> {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(knowledgeBaseId)}/connectors`,
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to fetch external sources'));
  }
  const payload = await res.json();
  return payload.data ?? [];
}

async function createKnowledgeBase(input: {
  name: string;
  description?: string;
  visibility: KnowledgeVisibility;
}) {
  const res = await fetch('/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to create knowledge base'));
  }
  return res.json();
}

async function updateKnowledgeBasePriority(input: {
  id: string;
  priority: number;
}) {
  const res = await fetch('/api/knowledge', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to update priority'));
  }
  return res.json();
}

async function createKnowledgeConnector(input: {
  knowledgeBaseId: string;
  name: string;
  sourceUri: string;
}) {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(input.knowledgeBaseId)}/connectors`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        source_uri: input.sourceUri,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to add external source'));
  }
  return res.json();
}

async function addKnowledgeDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content: string;
}) {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(input.knowledgeBaseId)}/documents`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        content: input.content,
        source_type: 'text',
      }),
    },
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to import document'));
  }
  return res.json();
}

async function deleteKnowledgeBase(id: string) {
  const res = await fetch(`/api/knowledge?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to delete knowledge base'));
  }
}

async function deleteKnowledgeDocument(input: {
  knowledgeBaseId: string;
  documentId: string;
}) {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(
      input.knowledgeBaseId,
    )}/documents?document_id=${encodeURIComponent(input.documentId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to delete document'));
  }
}

async function syncKnowledgeConnector(input: {
  knowledgeBaseId: string;
  connectorId: string;
}) {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(
      input.knowledgeBaseId,
    )}/connectors/${encodeURIComponent(input.connectorId)}/sync`,
    { method: 'POST' },
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to sync external source'));
  }
  return res.json();
}

async function deleteKnowledgeConnector(input: {
  knowledgeBaseId: string;
  connectorId: string;
}) {
  const res = await fetch(
    `/api/knowledge/${encodeURIComponent(
      input.knowledgeBaseId,
    )}/connectors?connector_id=${encodeURIComponent(input.connectorId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to delete external source'));
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatOptionalDate(value: string | null) {
  return value ? formatDate(value) : 'Never';
}

function connectorStatusVariant(status: KnowledgeConnector['syncStatus']) {
  if (status === 'failed') {
    return 'destructive';
  }
  if (status === 'syncing') {
    return 'secondary';
  }
  return 'outline';
}

export function KnowledgeManagement() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<KnowledgeVisibility>('private');
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [connectorName, setConnectorName] = useState('');
  const [connectorUrl, setConnectorUrl] = useState('');
  const [priorityValue, setPriorityValue] = useState('0');

  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: fetchKnowledgeBases,
  });
  const bases = data?.data ?? [];
  const isAdmin = data?.meta?.isAdmin === true;
  const selectedBase = useMemo(
    () => bases.find((base) => base.id === selectedId) ?? bases[0] ?? null,
    [bases, selectedId],
  );

  useEffect(() => {
    if (isAdmin) {
      setVisibility('team');
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!selectedBase) {
      setSelectedId(null);
      return;
    }
    if (selectedBase.id !== selectedId) {
      setSelectedId(selectedBase.id);
    }
  }, [selectedBase, selectedId]);

  useEffect(() => {
    if (selectedBase) {
      setPriorityValue(String(selectedBase.priority ?? 0));
    }
  }, [selectedBase]);

  const documentsQuery = useQuery({
    queryKey: ['knowledge-documents', selectedBase?.id],
    queryFn: () => fetchKnowledgeDocuments(selectedBase?.id ?? ''),
    enabled: Boolean(selectedBase?.id),
  });

  const connectorsQuery = useQuery({
    queryKey: ['knowledge-connectors', selectedBase?.id],
    queryFn: () => fetchKnowledgeConnectors(selectedBase?.id ?? ''),
    enabled: Boolean(selectedBase?.id),
  });

  const createMutation = useMutation({
    mutationFn: createKnowledgeBase,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] });
      setName('');
      setDescription('');
      setCreateOpen(false);
      toast.success('Knowledge base created');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addDocumentMutation = useMutation({
    mutationFn: addKnowledgeDocument,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['knowledge-documents', selectedBase?.id],
      });
      setDocumentTitle('');
      setDocumentContent('');
      setDocumentOpen(false);
      toast.success('Document imported');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updatePriorityMutation = useMutation({
    mutationFn: updateKnowledgeBasePriority,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] });
      toast.success('Knowledge priority updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addConnectorMutation = useMutation({
    mutationFn: createKnowledgeConnector,
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['knowledge-connectors', variables.knowledgeBaseId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['knowledge-documents', variables.knowledgeBaseId],
        }),
      ]);
      setConnectorName('');
      setConnectorUrl('');
      setConnectorOpen(false);
      toast.success('External source synced');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteBaseMutation = useMutation({
    mutationFn: deleteKnowledgeBase,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] });
      setSelectedId(null);
      toast.success('Knowledge base deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: deleteKnowledgeDocument,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['knowledge-documents', selectedBase?.id],
      });
      toast.success('Document deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const syncConnectorMutation = useMutation({
    mutationFn: syncKnowledgeConnector,
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['knowledge-connectors', variables.knowledgeBaseId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['knowledge-documents', variables.knowledgeBaseId],
        }),
      ]);
      toast.success('External source synced');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteConnectorMutation = useMutation({
    mutationFn: deleteKnowledgeConnector,
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['knowledge-connectors', variables.knowledgeBaseId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['knowledge-documents', variables.knowledgeBaseId],
        }),
      ]);
      toast.success('External source deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const priorityNumber = Number(priorityValue);
  const canSavePriority =
    Boolean(selectedBase?.canManage) &&
    Number.isFinite(priorityNumber) &&
    Math.trunc(priorityNumber) !== (selectedBase?.priority ?? 0) &&
    !updatePriorityMutation.isPending;

  return (
    <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[360px_1fr]">
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-xl tracking-tight">
              Knowledge Bases
            </h2>
            <p className="text-muted-foreground text-sm">
              Team bases plus your private overlay.
            </p>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 size-4" />
                Add
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Knowledge Base</DialogTitle>
                <DialogDescription>
                  Team bases are admin-managed; private bases belong to one
                  user.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="grid gap-2">
                  <Label htmlFor="knowledge-name">Name</Label>
                  <Input
                    id="knowledge-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="knowledge-description">Description</Label>
                  <Textarea
                    id="knowledge-description"
                    rows={3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Scope</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={visibility === 'private' ? 'default' : 'outline'}
                      onClick={() => setVisibility('private')}
                    >
                      Private
                    </Button>
                    <Button
                      type="button"
                      variant={visibility === 'team' ? 'default' : 'outline'}
                      disabled={!isAdmin}
                      onClick={() => setVisibility('team')}
                    >
                      Team
                    </Button>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button
                  disabled={createMutation.isPending || !name.trim()}
                  onClick={() =>
                    createMutation.mutate({
                      name: name.trim(),
                      description: description.trim() || undefined,
                      visibility,
                    })
                  }
                >
                  {createMutation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 size-4" />
                  )}
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="space-y-2">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={`knowledge-skeleton-${index}`} className="h-20" />
            ))
          ) : bases.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
              No knowledge bases yet
            </div>
          ) : (
            bases.map((base) => (
              <button
                key={base.id}
                type="button"
                className={cn(
                  'w-full rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50',
                  selectedBase?.id === base.id && 'border-primary bg-muted/40',
                )}
                onClick={() => setSelectedId(base.id)}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <BookOpen className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate font-medium">{base.name}</div>
                      <Badge
                        variant={
                          base.visibility === 'team' ? 'secondary' : 'outline'
                        }
                        className="shrink-0 rounded-md"
                      >
                        {base.visibility === 'team' ? 'Team' : 'Private'}
                      </Badge>
                      <Badge variant="outline" className="shrink-0 rounded-md">
                        P {base.priority}
                      </Badge>
                    </div>
                    <div className="mt-1 line-clamp-2 text-muted-foreground text-xs">
                      {base.description || 'No description'}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="min-w-0">
        {selectedBase ? (
          <Card className="rounded-lg">
            <CardContent className="space-y-5 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold text-lg">
                      {selectedBase.name}
                    </h3>
                    <Badge className="rounded-md" variant="secondary">
                      {selectedBase.agentId}
                    </Badge>
                    <Badge className="rounded-md" variant="outline">
                      P {selectedBase.priority}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {selectedBase.description || 'No description'}
                  </p>
                  <p className="mt-2 text-muted-foreground text-xs">
                    Imported documents and synced external sources are searched
                    together in this knowledge base.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="grid max-w-40 gap-1.5">
                      <Label htmlFor={`knowledge-priority-${selectedBase.id}`}>
                        Priority
                      </Label>
                      <Input
                        id={`knowledge-priority-${selectedBase.id}`}
                        type="number"
                        min={-1000}
                        max={1000}
                        step={1}
                        disabled={!selectedBase.canManage}
                        value={priorityValue}
                        onChange={(event) =>
                          setPriorityValue(event.target.value)
                        }
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canSavePriority}
                      onClick={() =>
                        updatePriorityMutation.mutate({
                          id: selectedBase.id,
                          priority: priorityNumber,
                        })
                      }
                    >
                      {updatePriorityMutation.isPending ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 size-4" />
                      )}
                      Save
                    </Button>
                    <p className="text-muted-foreground text-xs sm:pb-2">
                      Higher priority wins when sources conflict.
                    </p>
                  </div>
                  <p className="mt-2 text-muted-foreground text-xs">
                    Updated {formatDate(selectedBase.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Dialog open={documentOpen} onOpenChange={setDocumentOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" disabled={!selectedBase.canManage}>
                        <Upload className="mr-2 size-4" />
                        Import
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Import Document</DialogTitle>
                        <DialogDescription>
                          Text is chunked and indexed into this knowledge base.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-4 py-2">
                        <div className="grid gap-2">
                          <Label htmlFor="document-title">Title</Label>
                          <Input
                            id="document-title"
                            value={documentTitle}
                            onChange={(event) =>
                              setDocumentTitle(event.target.value)
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="document-content">Content</Label>
                          <Textarea
                            id="document-content"
                            rows={12}
                            value={documentContent}
                            onChange={(event) =>
                              setDocumentContent(event.target.value)
                            }
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          disabled={
                            addDocumentMutation.isPending ||
                            !documentTitle.trim() ||
                            !documentContent.trim()
                          }
                          onClick={() =>
                            addDocumentMutation.mutate({
                              knowledgeBaseId: selectedBase.id,
                              title: documentTitle.trim(),
                              content: documentContent.trim(),
                            })
                          }
                        >
                          {addDocumentMutation.isPending ? (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                          ) : (
                            <Upload className="mr-2 size-4" />
                          )}
                          Import
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Delete knowledge base ${selectedBase.name}`}
                    disabled={
                      !selectedBase.canManage || deleteBaseMutation.isPending
                    }
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete knowledge base "${selectedBase.name}"?`,
                        )
                      ) {
                        deleteBaseMutation.mutate(selectedBase.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="font-medium text-sm">External Sources</h4>
                    <p className="mt-1 text-muted-foreground text-xs">
                      Connected URLs are synced into this knowledge base and
                      searched with imported documents.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {connectorsQuery.isFetching ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : null}
                    <Dialog
                      open={connectorOpen}
                      onOpenChange={setConnectorOpen}
                    >
                      <DialogTrigger asChild>
                        <Button size="sm" disabled={!selectedBase.canManage}>
                          <Link2 className="mr-2 size-4" />
                          Add URL
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-lg">
                        <DialogHeader>
                          <DialogTitle>Add URL Source</DialogTitle>
                          <DialogDescription>
                            The URL is fetched, chunked, and indexed into the
                            selected knowledge base.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-4 py-2">
                          <div className="grid gap-2">
                            <Label htmlFor="connector-name">Name</Label>
                            <Input
                              id="connector-name"
                              value={connectorName}
                              onChange={(event) =>
                                setConnectorName(event.target.value)
                              }
                              placeholder="Product docs"
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="connector-url">URL</Label>
                            <Input
                              id="connector-url"
                              value={connectorUrl}
                              onChange={(event) =>
                                setConnectorUrl(event.target.value)
                              }
                              placeholder="https://example.com/docs"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            disabled={
                              addConnectorMutation.isPending ||
                              !connectorUrl.trim()
                            }
                            onClick={() =>
                              addConnectorMutation.mutate({
                                knowledgeBaseId: selectedBase.id,
                                name: connectorName.trim(),
                                sourceUri: connectorUrl.trim(),
                              })
                            }
                          >
                            {addConnectorMutation.isPending ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <Link2 className="mr-2 size-4" />
                            )}
                            Add and Sync
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>

                {connectorsQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, index) => (
                      <Skeleton
                        key={`connector-skeleton-${index}`}
                        className="h-16"
                      />
                    ))}
                  </div>
                ) : (connectorsQuery.data ?? []).length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
                    No external sources connected
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(connectorsQuery.data ?? []).map((connector) => {
                      const isSyncing =
                        syncConnectorMutation.isPending &&
                        syncConnectorMutation.variables?.connectorId ===
                          connector.id;
                      const isDeleting =
                        deleteConnectorMutation.isPending &&
                        deleteConnectorMutation.variables?.connectorId ===
                          connector.id;

                      return (
                        <div
                          key={connector.id}
                          className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
                        >
                          <Link2 className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <div className="min-w-0 truncate font-medium text-sm">
                                {connector.name}
                              </div>
                              <Badge
                                className="shrink-0 rounded-md"
                                variant={connectorStatusVariant(
                                  connector.syncStatus,
                                )}
                              >
                                {connector.syncStatus}
                              </Badge>
                            </div>
                            <div className="mt-1 truncate text-muted-foreground text-xs">
                              {connector.sourceUri}
                            </div>
                            <div className="mt-1 text-muted-foreground text-xs">
                              Last synced{' '}
                              {formatOptionalDate(connector.lastSyncedAt)}
                            </div>
                            {connector.lastError ? (
                              <div className="mt-1 line-clamp-2 text-destructive text-xs">
                                {connector.lastError}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1 self-start sm:self-center">
                            <Button size="sm" variant="ghost" asChild>
                              <a
                                href={connector.sourceUri}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open external source ${connector.name}`}
                              >
                                <ExternalLink className="size-4" />
                              </a>
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Sync external source ${connector.name}`}
                              disabled={
                                !selectedBase.canManage ||
                                syncConnectorMutation.isPending ||
                                connector.syncStatus === 'syncing'
                              }
                              onClick={() =>
                                syncConnectorMutation.mutate({
                                  knowledgeBaseId: selectedBase.id,
                                  connectorId: connector.id,
                                })
                              }
                            >
                              {isSyncing ||
                              connector.syncStatus === 'syncing' ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              aria-label={`Delete external source ${connector.name}`}
                              disabled={
                                !selectedBase.canManage ||
                                deleteConnectorMutation.isPending
                              }
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete external source "${connector.name}"?`,
                                  )
                                ) {
                                  deleteConnectorMutation.mutate({
                                    knowledgeBaseId: selectedBase.id,
                                    connectorId: connector.id,
                                  });
                                }
                              }}
                            >
                              {isDeleting ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Trash2 className="size-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">Imported Documents</h4>
                  {documentsQuery.isFetching ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : null}
                </div>

                {documentsQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton
                        key={`document-skeleton-${index}`}
                        className="h-14"
                      />
                    ))}
                  </div>
                ) : (documentsQuery.data ?? []).length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
                    No documents imported
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(documentsQuery.data ?? []).map((document) => (
                      <div
                        key={document.id}
                        className="flex items-center gap-3 rounded-lg border p-3"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-sm">
                            {document.title}
                          </div>
                          <div className="text-muted-foreground text-xs">
                            {document.sourceType} ·{' '}
                            {formatDate(document.createdAt)}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Delete document ${document.title}`}
                          disabled={
                            !selectedBase.canManage ||
                            deleteDocumentMutation.isPending
                          }
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete document "${document.title}"?`,
                              )
                            ) {
                              deleteDocumentMutation.mutate({
                                knowledgeBaseId: selectedBase.id,
                                documentId: document.id,
                              });
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed text-muted-foreground text-sm">
            Select or create a knowledge base
          </div>
        )}
      </div>
    </div>
  );
}
