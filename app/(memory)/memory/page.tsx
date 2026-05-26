'use client';

import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  createLongTermMemoryAction,
  deleteLongTermMemoryAction,
  listBuiltinMemorySectionsAction,
  listLongTermMemoriesAction,
  listSessionSummariesAction,
  updateBuiltinMemorySectionAction,
} from '@/app/(memory)/actions';
import { toast } from 'sonner';

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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

type Scope = 'builtin' | 'long_term' | 'session';

const BUILTIN_KEYS = ['AGENTS', 'SOUL', 'IDENTITY', 'USER'] as const;

interface BuiltinMemory {
  key: string;
  content: string;
  updatedAt: string | null;
}

interface LongTermMemory {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionSummary {
  id: string;
  sessionId: string;
  content: string;
  summaryVersion: number;
  isCurrent: boolean;
  createdAt: string;
}

interface BuiltinMemoryResponse {
  sections?: BuiltinMemory[];
}

interface LongTermMemoryListResponse {
  items?: LongTermMemory[];
}

export default function MemoryPage() {
  const [activeScope, setActiveScope] = useState<Scope>('builtin');

  return (
    <div className="flex flex-col min-w-0 h-dvh bg-background pb-16 md:pb-0">
      <header className="flex sticky top-0 bg-background py-3 items-center px-4 border-b">
         <h1 className="text-base md:text-lg font-semibold">Memory</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Scope tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {(['builtin', 'long_term', 'session'] as Scope[]).map((scope) => (
            <Button
              key={scope}
              size="sm"
              variant={activeScope === scope ? 'default' : 'secondary'}
              onClick={() => setActiveScope(scope)}
            >
              {scope === 'builtin'
                ? 'Builtin'
                : scope === 'long_term'
                  ? 'Long-term'
                  : 'Session'}
            </Button>
          ))}
        </div>

        {activeScope === 'builtin' && <BuiltinPanel />}
        {activeScope === 'long_term' && <LongTermPanel />}
        {activeScope === 'session' && <SessionPanel />}
      </div>
    </div>
  );
}

/* ─── Builtin Panel ─────────────────────────────────────────────── */

function BuiltinPanel() {
  const [memories, setMemories] = useState<Record<string, BuiltinMemory>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loadBuiltin = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBuiltinMemorySectionsAction();
      const map: Record<string, BuiltinMemory> = {};
      for (const m of data.sections ?? []) {
        map[m.key] = m;
      }
      setMemories(map);
      const d: Record<string, string> = {};
      for (const key of BUILTIN_KEYS) {
        d[key] = map[key]?.content ?? '';
      }
      setDrafts(d);
    } catch {
      toast.error('Failed to load builtin memories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBuiltin();
  }, [loadBuiltin]);

  async function saveKey(key: string) {
    setSavingKey(key);
    try {
      await updateBuiltinMemorySectionAction({
        key,
        content: drafts[key] ?? '',
      });
      toast.success(`${key} saved`);
      await loadBuiltin();
    } catch {
      toast.error(`Failed to save ${key}`);
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="space-y-3">
            <Skeleton className="h-4 w-full" />
          </CardHeader>
        </Card>
        {BUILTIN_KEYS.map((key) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-8 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <p className="text-sm text-muted-foreground">
            These built-in memories are used to build system prompts, making
            your Agent customizable to you.
          </p>
        </CardHeader>
      </Card>
      {BUILTIN_KEYS.map((key) => (
        <Card key={key}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono">{key}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              rows={4}
              value={drafts[key] ?? ''}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
              }
              placeholder={`${key} content...`}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {memories[key]?.updatedAt
                  ? `Updated: ${new Date(memories[key].updatedAt).toLocaleString()}`
                  : 'Not set'}
              </span>
              <Button
                size="sm"
                disabled={savingKey === key}
                onClick={() => saveKey(key)}
              >
                {savingKey === key ? (
                  <Loader2 className="size-4 animate-spin mr-1" />
                ) : (
                  <Save className="size-4 mr-1" />
                )}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ─── Long-term Panel ───────────────────────────────────────────── */

function LongTermPanel() {
  const [memories, setMemories] = useState<LongTermMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [deletingMap, setDeletingMap] = useState<Record<string, boolean>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const loadMemories = useCallback(async (search?: string) => {
    setLoading(true);
    try {
      const data = await listLongTermMemoriesAction({
        page: 1,
        pageSize: 100,
        search: search || undefined,
      });
      setMemories(data.items ?? []);
    } catch {
      toast.error('Failed to load long-term memories');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    try {
      await loadMemories(searchQuery);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, loadMemories]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  async function create() {
    const content = newContent.trim();
    if (!content) return;
    setCreating(true);
    try {
      const result = await createLongTermMemoryAction({ content });
      setNewContent('');
      toast.success(
        result.indexing?.mode === 'embedded'
          ? 'Memory created and embedded'
          : 'Memory created in keyword-only mode',
      );
      await loadMemories();
    } catch {
      toast.error('Failed to create memory');
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (deletingMap[id]) return;
    setDeletingMap((prev) => ({ ...prev, [id]: true }));
    try {
      await deleteLongTermMemoryAction(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      toast.success('Memory deleted');
    } catch {
      toast.error('Failed to delete memory');
    } finally {
      setDeletingMap((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-2">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search memories..."
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch();
          }}
        />
        <Button onClick={handleSearch} disabled={searching || loading} variant="outline" size="sm">
          {searching ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
        </Button>
        {searchQuery && (
          <Button
            onClick={() => { setSearchQuery(''); loadMemories(); }}
            variant="ghost"
            size="sm"
          >
            Clear
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Long-term Memory</CardTitle>
          <p className="text-sm text-muted-foreground">
            Claw can remember your preferences and knowledge across this
            single-user project.
          </p>
          <p className="text-sm text-muted-foreground">
            Setting the <span className="font-medium">embedding model</span> in
            the AI configuration can make retrieval more accurate, but memory
            still saves even if embeddings are unavailable.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={3}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Memory content..."
          />
          <div className="flex justify-end">
            <Button onClick={create} disabled={creating}>
              {creating ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Plus className="size-4 mr-1" />
              )}
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Card key={`skeleton-${i}`}>
              <CardContent className="pt-4 space-y-2">
                <Skeleton className="h-16 w-full" />
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : memories.length === 0 ? (
        <div className="text-sm text-muted-foreground p-6 border border-dashed rounded-lg text-center">
          No long-term memories yet
        </div>
      ) : (
        <div className="space-y-3">
          {memories.map((item) => (
            <Card key={item.id}>
              <CardContent className="pt-4 space-y-2">
                <p className="text-sm whitespace-pre-wrap">{item.content}</p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={deletingMap[item.id]}
                    onClick={() => setPendingDeleteId(item.id)}
                  >
                    {deletingMap[item.id] ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    <span className="ml-1">Delete</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Memory</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this memory? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteId) {
                  remove(pendingDeleteId);
                  setPendingDeleteId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ─── Session Panel ─────────────────────────────────────────────── */

function SessionPanel() {
  const [sessionId, setSessionId] = useState('');
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadSummaries() {
    const sid = sessionId.trim();
    if (!sid) {
      toast.error('Enter a session ID');
      return;
    }
    setLoading(true);
    try {
      const data = await listSessionSummariesAction({ sessionId: sid });
      setSummaries(data.summaries ?? []);
    } catch {
      toast.error('Failed to load session summaries');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session Summaries</CardTitle>
          <p className="text-sm text-muted-foreground">
            Session memory is isolated within each session, which is especially
            useful for long sessions.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="Session ID"
              className="flex-1"
            />
            <Button onClick={loadSummaries} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : 'Load'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {summaries.length === 0 ? (
        <div className="text-sm text-muted-foreground p-6 border border-dashed rounded-lg text-center">
          {sessionId.trim()
            ? 'No summaries for this session'
            : 'Enter a session ID to view summaries'}
        </div>
      ) : (
        <div className="space-y-3">
          {summaries.map((s) => (
            <Card key={s.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <code className="px-2 py-0.5 rounded bg-muted text-xs">
                    v{s.summaryVersion}
                  </code>
                  {s.isCurrent && (
                    <span className="text-xs font-medium text-green-600">
                      current
                    </span>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap">{s.content}</p>
                <span className="text-xs text-muted-foreground block">
                  {new Date(s.createdAt).toLocaleString()}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
