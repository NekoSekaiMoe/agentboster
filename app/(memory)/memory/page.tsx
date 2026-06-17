'use client';

import { Download, Loader2, Plus, Save, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearSessionSoulAction,
  createLongTermMemoryAction,
  deleteLongTermMemoryAction,
  getSessionSoulAction,
  listBuiltinMemorySectionsAction,
  listLongTermMemoriesAction,
  listMemoryAuthorsAction,
  listSessionSummariesAction,
  setSessionSoulAction,
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
import { WorkspacePageHeader } from '@/components/workspace-page-header';
import { useI18n } from '@/components/i18n-provider';
import {
  BUILTIN_MEMORY_MAX_LENGTH,
  SOUL_MEMORY_MAX_LENGTH,
} from '@/types/memory/builtin';

type Scope = 'builtin' | 'long_term' | 'session' | 'soul';

const BUILTIN_KEYS = ['AGENTS', 'SOUL', 'IDENTITY', 'USER'] as const;

interface BuiltinMemory {
  key: string;
  content: string;
  updatedAt: string | null;
}

interface LongTermMemory {
  id: string;
  userId: string | null;
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

export default function MemoryPage() {
  const [activeScope, setActiveScope] = useState<Scope>('builtin');

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background pb-16 md:pb-0">
      <WorkspacePageHeader
        title="Memory"
        description="Manage builtin, long-term, session, and SOUL memory."
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(['builtin', 'soul', 'long_term', 'session'] as Scope[]).map(
            (scope) => (
              <Button
                key={scope}
                size="sm"
                variant={activeScope === scope ? 'default' : 'secondary'}
                onClick={() => setActiveScope(scope)}
              >
                {scope === 'builtin'
                  ? 'Builtin'
                  : scope === 'soul'
                    ? 'SOUL.md'
                    : scope === 'long_term'
                      ? 'Long-term'
                      : 'Session'}
              </Button>
            ),
          )}
        </div>

        {activeScope === 'builtin' && <BuiltinPanel />}
        {activeScope === 'soul' && <SoulPanel />}
        {activeScope === 'long_term' && <LongTermPanel />}
        {activeScope === 'session' && <SessionPanel />}
      </div>
    </div>
  );
}

/* ─── SOUL.md Panel ─────────────────────────────────────────────── */

function SoulPanel() {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadSoul = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBuiltinMemorySectionsAction();
      const soul = data.sections?.find((s) => s.key === 'SOUL');
      setContent(soul?.content ?? '');
      setUpdatedAt(soul?.updatedAt ?? null);
    } catch {
      toast.error(t('toast.soul.globalLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSoul();
  }, [loadSoul]);

  async function save() {
    setSaving(true);
    try {
      await updateBuiltinMemorySectionAction({ key: 'SOUL', content });
      toast.success(t('toast.soul.saved'));
      await loadSoul();
    } catch {
      toast.error(t('toast.soul.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.md')) {
      toast.error(t('toast.soul.invalidFile'));
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setContent(text);
      toast.success(t('toast.soul.fileLoaded'));
    };
    reader.readAsText(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function downloadSoul() {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SOUL.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-2 pt-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 pt-4">
            <Skeleton className="h-64 w-full" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-8 w-20" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-base">SOUL.md</CardTitle>
          <p className="text-muted-foreground text-sm">
            SOUL.md 定义 Agent 的人格、语气和风格。支持上传 .md
            文件或直接在下方编辑。
            内容会注入到系统提示中，影响所有会话的行为表现。
          </p>
          <p className="text-muted-foreground text-xs">
            最大长度：{SOUL_MEMORY_MAX_LENGTH.toLocaleString()} 字符
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md"
              className="hidden"
              onChange={handleFileUpload}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mr-1 size-4" />
              上传 .md
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadSoul}
              disabled={!content}
            >
              <Download className="mr-1 size-4" />
              下载 SOUL.md
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <Textarea
            rows={16}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={SOUL_MEMORY_MAX_LENGTH}
            placeholder="在此编辑 SOUL.md 内容..."
            className="font-mono text-sm"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground text-xs">
                {content.length} / {SOUL_MEMORY_MAX_LENGTH.toLocaleString()}{' '}
                字符
              </span>
              {updatedAt && (
                <span className="text-muted-foreground text-xs">
                  更新于: {new Date(updatedAt).toLocaleString()}
                </span>
              )}
            </div>
            <Button size="sm" disabled={saving} onClick={save}>
              {saving ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Save className="mr-1 size-4" />
              )}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Builtin Panel ─────────────────────────────────────────────── */

function BuiltinPanel() {
  const { t } = useI18n();
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
      toast.error(t('toast.memory.builtinLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
          <p className="text-muted-foreground text-sm">
            These built-in memories are used to build system prompts, making
            your Agent customizable to you.
          </p>
        </CardHeader>
      </Card>
      {BUILTIN_KEYS.map((key) => (
        <Card key={key}>
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-sm">{key}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              rows={key === 'SOUL' ? 8 : 4}
              value={drafts[key] ?? ''}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
              }
              maxLength={BUILTIN_MEMORY_MAX_LENGTH}
              placeholder={`${key} content...`}
              className={key === 'SOUL' ? 'font-mono text-sm' : undefined}
            />
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1 text-muted-foreground text-xs sm:flex-row sm:items-center sm:gap-3">
                <span>
                  {(drafts[key] ?? '').length} /{' '}
                  {BUILTIN_MEMORY_MAX_LENGTH.toLocaleString()} 字符
                </span>
                <span>
                  {memories[key]?.updatedAt
                    ? `Updated: ${new Date(memories[key].updatedAt).toLocaleString()}`
                    : 'Not set'}
                </span>
              </div>
              <Button
                size="sm"
                disabled={savingKey === key}
                onClick={() => saveKey(key)}
              >
                {savingKey === key ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Save className="mr-1 size-4" />
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
  const { t } = useI18n();
  const [memories, setMemories] = useState<LongTermMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [deletingMap, setDeletingMap] = useState<Record<string, boolean>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authors, setAuthors] = useState<
    Array<{ id: string; username: string }>
  >([]);
  const [createTargetUserId, setCreateTargetUserId] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listMemoryAuthorsAction();
        if (cancelled) return;
        setIsAdmin(result.isAdmin);
        if (result.isAdmin) {
          setAuthors(result.authors);
        }
      } catch {
        // Non-admin or fetch failed — stay in single-user mode silently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const usernameById = useCallback(
    (userId: string | null) => {
      if (!userId) return 'unknown';
      const found = authors.find((a) => a.id === userId);
      return found?.username ?? userId;
    },
    [authors],
  );

  const loadMemories = useCallback(
    async (search?: string) => {
      setLoading(true);
      try {
        const data = await listLongTermMemoriesAction({
          page: 1,
          pageSize: 100,
          search: search || undefined,
        });
        setMemories(data.items ?? []);
      } catch {
        toast.error(t('toast.memory.longTermLoadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

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
      const result = await createLongTermMemoryAction(
        isAdmin && createTargetUserId
          ? { content, userId: createTargetUserId }
          : { content },
      );
      setNewContent('');
      toast.success(
        result.indexing?.mode === 'embedded'
          ? 'Memory created and embedded'
          : 'Memory created in keyword-only mode',
      );
      await loadMemories();
    } catch {
      toast.error(t('toast.memory.createFailed'));
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
      toast.success(t('toast.memory.deleted'));
    } catch {
      toast.error(t('toast.memory.deleteFailed'));
    } finally {
      setDeletingMap((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
          Admin view: showing memories from all users. Each card is tagged with
          its owner. Use the “Owner” selector below to write to a specific user
          (including <span className="font-mono">system</span>).
        </div>
      ) : null}

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
        <Button
          onClick={handleSearch}
          disabled={searching || loading}
          variant="outline"
          size="sm"
        >
          {searching ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
        </Button>
        {searchQuery && (
          <Button
            onClick={() => {
              setSearchQuery('');
              loadMemories();
            }}
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
          <p className="text-muted-foreground text-sm">
            Claw can remember your preferences and knowledge across this
            single-user project.
          </p>
          <p className="text-muted-foreground text-sm">
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
          {isAdmin ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Owner:</span>
              <select
                value={createTargetUserId}
                onChange={(e) => setCreateTargetUserId(e.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              >
                <option value="">(myself)</option>
                {authors.map((author) => (
                  <option key={author.id} value={author.id}>
                    {author.username === author.id
                      ? author.username
                      : `${author.username} (${author.id})`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button onClick={create} disabled={creating}>
              {creating ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Plus className="mr-1 size-4" />
              )}
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={`skeleton-${i}`}>
              <CardContent className="space-y-2 pt-4">
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
        <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No long-term memories yet
        </div>
      ) : (
        <div className="space-y-3">
          {memories.map((item) => (
            <Card key={item.id}>
              <CardContent className="space-y-2 pt-4">
                <p className="whitespace-pre-wrap text-sm">{item.content}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">
                    {new Date(item.createdAt).toLocaleString()}
                    {isAdmin ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono">
                        {usernameById(item.userId)}
                      </span>
                    ) : null}
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
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState('');
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [sessionSoul, setSessionSoul] = useState('');
  const [sessionSoulScope, setSessionSoulScope] = useState<
    'session' | 'global' | null
  >(null);
  const [savingSoul, setSavingSoul] = useState(false);
  const [loadingSoul, setLoadingSoul] = useState(false);

  async function loadSummaries() {
    const sid = sessionId.trim();
    if (!sid) {
      toast.error(t('toast.notification.needSessionId'));
      return;
    }
    setLoading(true);
    try {
      const data = await listSessionSummariesAction({ sessionId: sid });
      setSummaries(data.summaries ?? []);
    } catch {
      toast.error(t('toast.summary.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function loadSessionSoul() {
    const sid = sessionId.trim();
    if (!sid) {
      toast.error(t('toast.notification.needSessionId'));
      return;
    }
    setLoadingSoul(true);
    try {
      const data = await getSessionSoulAction(sid);
      setSessionSoul(data.content);
      setSessionSoulScope(data.scope);
    } catch {
      toast.error(t('toast.soul.sessionLoadFailed'));
    } finally {
      setLoadingSoul(false);
    }
  }

  async function saveSessionSoul() {
    const sid = sessionId.trim();
    if (!sid) return;
    setSavingSoul(true);
    try {
      await setSessionSoulAction(sid, sessionSoul);
      toast.success(t('toast.soul.sessionSaved'));
      await loadSessionSoul();
    } catch {
      toast.error(t('toast.soul.sessionSaveFailed'));
    } finally {
      setSavingSoul(false);
    }
  }

  async function clearSessionSoul() {
    const sid = sessionId.trim();
    if (!sid) return;
    try {
      await clearSessionSoulAction(sid);
      setSessionSoul('');
      setSessionSoulScope(null);
      toast.success(t('toast.soul.cleared'));
    } catch {
      toast.error(t('toast.soul.clearFailed'));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session Summaries</CardTitle>
          <p className="text-muted-foreground text-sm">
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

      {sessionId.trim() && (
        <Card>
          <CardHeader className="space-y-2">
            <CardTitle className="text-base">Session SOUL</CardTitle>
            <p className="text-muted-foreground text-sm">
              为此会话设置独立的 SOUL 内容，覆盖全局 SOUL.md。
              {sessionSoulScope === 'global' && sessionSoul && (
                <span className="ml-1 text-amber-500">
                  （当前使用全局 SOUL）
                </span>
              )}
              {sessionSoulScope === 'session' && (
                <span className="ml-1 text-green-600">
                  （已设置会话级 SOUL）
                </span>
              )}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingSoul}
                onClick={loadSessionSoul}
              >
                {loadingSoul ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : null}
                加载 SOUL
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={savingSoul}
                onClick={saveSessionSoul}
              >
                {savingSoul ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Save className="mr-1 size-4" />
                )}
                保存
              </Button>
              {sessionSoulScope === 'session' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={clearSessionSoul}
                >
                  <Trash2 className="mr-1 size-4" />
                  清除覆盖
                </Button>
              )}
            </div>
            <Textarea
              rows={8}
              value={sessionSoul}
              onChange={(e) => setSessionSoul(e.target.value)}
              maxLength={SOUL_MEMORY_MAX_LENGTH}
              placeholder="会话级 SOUL 内容（留空则使用全局 SOUL.md）..."
              className="font-mono text-sm"
            />
            <span className="text-muted-foreground text-xs">
              {sessionSoul.length} / {SOUL_MEMORY_MAX_LENGTH.toLocaleString()}{' '}
              字符
            </span>
          </CardContent>
        </Card>
      )}

      {summaries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          {sessionId.trim()
            ? 'No summaries for this session'
            : 'Enter a session ID to view summaries'}
        </div>
      ) : (
        <div className="space-y-3">
          {summaries.map((s) => (
            <Card key={s.id}>
              <CardContent className="space-y-2 pt-4">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-2 py-0.5 text-xs">
                    v{s.summaryVersion}
                  </code>
                  {s.isCurrent && (
                    <span className="font-medium text-green-600 text-xs">
                      current
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{s.content}</p>
                <span className="block text-muted-foreground text-xs">
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
