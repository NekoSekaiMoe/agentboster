'use client';

import {
  Check,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  type DreamPreviewOperation,
  type DreamProposalRecord,
  batchDreamProposalsAction,
  createDreamMemoryAction,
  deleteDreamProposalAction,
  listDreamProposalsAction,
  previewDreamRunAction,
  ratifyDreamProposalAction,
  updateDreamProposalAction,
} from '@/app/(memory)/actions';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

const SOURCE_KIND_LABEL: Record<string, string> = {
  user_asserted: '用户陈述',
  assistant_observed: '助手观察',
  tool_observed: '工具/网页',
  dream_consolidated: 'Dream 合并',
  dream_recombined: 'Dream 重组',
};

const SOURCE_KIND_BADGE: Record<string, string> = {
  user_asserted: 'bg-green-500/10 text-green-600',
  assistant_observed: 'bg-blue-500/10 text-blue-600',
  tool_observed: 'bg-amber-500/10 text-amber-600',
  dream_consolidated: 'bg-purple-500/10 text-purple-600',
  dream_recombined: 'bg-purple-500/10 text-purple-600',
};

const OP_TYPE_LABEL: Record<DreamPreviewOperation['type'], string> = {
  CONSOLIDATE: '合并',
  DELETE: '删除',
  SUPERSEDE: '取代',
  ADJUST_IMPORTANCE: '重要性',
};

const OP_TYPE_BADGE: Record<DreamPreviewOperation['type'], string> = {
  CONSOLIDATE: 'bg-purple-500/10 text-purple-600',
  DELETE: 'bg-red-500/10 text-red-600',
  SUPERSEDE: 'bg-gray-500/10 text-gray-600',
  ADJUST_IMPORTANCE: 'bg-blue-500/10 text-blue-600',
};

export function DreamPanel() {
  const [proposals, setProposals] = useState<DreamProposalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [batchActing, setBatchActing] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DreamProposalRecord | null>(null);

  // Create-form state.
  const [newContent, setNewContent] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newImportance, setNewImportance] = useState('5');
  const [newTriggers, setNewTriggers] = useState('');
  const [creating, setCreating] = useState(false);

  // Preview state.
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof previewDreamRunAction>
  > | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listDreamProposalsAction();
      setProposals(data.proposals ?? []);
    } catch {
      toast.error('加载 Dream 提案失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function ratify(id: string, ratified: boolean) {
    setActingId(id);
    try {
      await ratifyDreamProposalAction({ id, ratified });
      setProposals((prev) => prev.filter((p) => p.id !== id));
      toast.success(ratified ? '已批准，记忆已生效' : '已拒绝');
    } catch {
      toast.error('操作失败');
    } finally {
      setActingId(null);
    }
  }

  async function remove(id: string) {
    setActingId(id);
    try {
      await deleteDreamProposalAction(id);
      setProposals((prev) => prev.filter((p) => p.id !== id));
      toast.success('已删除');
    } catch {
      toast.error('删除失败');
    } finally {
      setActingId(null);
    }
  }

  async function batch(action: 'ratify-all' | 'reject-all') {
    setBatchActing(true);
    try {
      const result = await batchDreamProposalsAction({ action });
      toast.success(
        action === 'ratify-all'
          ? `已批准 ${result.processed} 条提案`
          : `已拒绝 ${result.processed} 条提案`,
      );
      await load();
    } catch {
      toast.error('批量操作失败');
    } finally {
      setBatchActing(false);
    }
  }

  async function create() {
    const content = newContent.trim();
    if (!content) return;
    setCreating(true);
    try {
      const triggerPhrases = newTriggers
        .split(/[,，;；]/)
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length >= 2);
      await createDreamMemoryAction({
        content,
        ...(newKey.trim() ? { key: newKey.trim() } : {}),
        importance: Number.parseInt(newImportance, 10) || 5,
        ...(triggerPhrases.length > 0 ? { triggerPhrases } : {}),
      });
      setNewContent('');
      setNewKey('');
      setNewImportance('5');
      setNewTriggers('');
      toast.success('记忆已创建并生效');
    } catch {
      toast.error('创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    try {
      const result = await previewDreamRunAction();
      setPreview(result);
      if (result.operations.length === 0) {
        toast.success('预览完成：本次运行不会产生任何变更');
      }
    } catch {
      toast.error('预览失败（Dream 预览需要调用模型，请稍后重试）');
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            Dream 记忆进化
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Dream
            是后台记忆固化流水线：夜间合并重复记忆、发现跨主题关联、根据召回频率调整重要性。
            它发现的「新关联」会先作为提案列在这里，经你批准后才会进入长期记忆。
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={previewing}
            onClick={runPreview}
          >
            {previewing ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Eye className="mr-1 size-4" />
            )}
            预览下次运行
          </Button>
          {proposals.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={batchActing}
                onClick={() => batch('ratify-all')}
              >
                {batchActing ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Check className="mr-1 size-4" />
                )}
                全部批准
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={batchActing}
                onClick={() => batch('reject-all')}
              >
                <X className="mr-1 size-4" />
                全部拒绝
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {preview && preview.operations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              预览结果：{preview.operations.length} 个待执行操作（
              {preview.memoryCount} 条记忆，变更预算 {preview.retiredBudget}）
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              合并 {preview.stats.consolidated} · 删除 {preview.stats.deleted} ·
              去重拒绝 {preview.stats.rejectedDuplicates} · 预算拒绝{' '}
              {preview.stats.rejectedBudget}
            </p>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {preview.operations.map((op, index) => (
              <div
                key={`${op.type}-${index}`}
                className="flex items-start gap-2 rounded-md border bg-muted/20 p-2 text-sm"
              >
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${OP_TYPE_BADGE[op.type]}`}
                >
                  {OP_TYPE_LABEL[op.type]}
                </span>
                <span className="whitespace-pre-wrap">{op.summary}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">新建记忆</CardTitle>
          <p className="text-muted-foreground text-sm">
            手动创建的记忆直接生效（无需审批），并标记为最高信任等级「用户陈述」。填写稳定
            key（如 user.location）后重复创建会更新同一条记忆。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={3}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="记忆内容..."
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="稳定 key（可选）"
            />
            <Input
              value={newImportance}
              onChange={(e) =>
                setNewImportance(e.target.value.replace(/[^0-9]/g, ''))
              }
              placeholder="重要性 1-10"
            />
            <Input
              value={newTriggers}
              onChange={(e) => setNewTriggers(e.target.value)}
              placeholder="触发短语，逗号分隔（可选）"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={create} disabled={creating || !newContent.trim()}>
              {creating ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Plus className="mr-1 size-4" />
              )}
              创建
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={`dream-skeleton-${i}`}>
              <CardContent className="space-y-2 pt-4">
                <Skeleton className="h-16 w-full" />
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-8 w-28" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          暂无待审批的 Dream 提案。Dream
          每次夜间运行后，新发现的关联会出现在这里。
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <Card key={proposal.id}>
              <CardContent className="space-y-2 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      SOURCE_KIND_BADGE[proposal.sourceKind] ??
                      'bg-gray-500/10 text-gray-600'
                    }`}
                  >
                    {SOURCE_KIND_LABEL[proposal.sourceKind] ??
                      proposal.sourceKind}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {proposal.memoryType} · 重要性 {proposal.importance}
                    {proposal.confidence !== null &&
                      ` · 置信度 ${proposal.confidence.toFixed(2)}`}
                  </span>
                  {proposal.key && (
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {proposal.key}
                    </code>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">
                  {proposal.content}
                </p>
                {proposal.rationale && (
                  <p className="rounded-md bg-muted/40 p-2 text-muted-foreground text-xs">
                    推荐理由：{proposal.rationale}
                  </p>
                )}
                {proposal.triggerPhrases &&
                  proposal.triggerPhrases.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {proposal.triggerPhrases.map((phrase) => (
                        <Badge
                          key={phrase}
                          variant="secondary"
                          className="text-[10px]"
                        >
                          {phrase}
                        </Badge>
                      ))}
                    </div>
                  )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">
                    {new Date(proposal.createdAt).toLocaleString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actingId === proposal.id}
                      onClick={() => ratify(proposal.id, true)}
                    >
                      <Check className="mr-1 size-4" />
                      批准
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actingId === proposal.id}
                      onClick={() => ratify(proposal.id, false)}
                    >
                      <X className="mr-1 size-4" />
                      拒绝
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actingId === proposal.id}
                      onClick={() => setEditing(proposal)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={actingId === proposal.id}
                      onClick={() => setPendingDeleteId(proposal.id)}
                    >
                      {actingId === proposal.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <EditProposalDialog
        proposal={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setProposals((prev) =>
            prev.map((p) => (p.id === updated.id ? updated : p)),
          );
          setEditing(null);
        }}
      />

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除提案</AlertDialogTitle>
            <AlertDialogDescription>
              删除会彻底移除该提案（未来的 Dream
              运行可能再次提出它）。如果希望它不再出现，请使用「拒绝」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteId) {
                  remove(pendingDeleteId);
                  setPendingDeleteId(null);
                }
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EditProposalDialog({
  proposal,
  onClose,
  onSaved,
}: {
  proposal: DreamProposalRecord | null;
  onClose: () => void;
  onSaved: (updated: DreamProposalRecord) => void;
}) {
  const [content, setContent] = useState('');
  const [importance, setImportance] = useState('5');
  const [triggers, setTriggers] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (proposal) {
      setContent(proposal.content);
      setImportance(String(proposal.importance));
      setTriggers((proposal.triggerPhrases ?? []).join(', '));
    }
  }, [proposal]);

  async function save() {
    if (!proposal || !content.trim()) return;
    setSaving(true);
    try {
      const triggerPhrases = triggers
        .split(/[,，;；]/)
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length >= 2);
      const result = await updateDreamProposalAction({
        id: proposal.id,
        content: content.trim(),
        importance: Number.parseInt(importance, 10) || proposal.importance,
        triggerPhrases,
      });
      toast.success('提案已更新');
      onSaved(result.proposal);
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={proposal !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑提案</DialogTitle>
          <DialogDescription>
            修改内容、重要性和触发短语后再批准，记忆将以编辑后的版本生效。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="提案内容..."
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={importance}
              onChange={(e) =>
                setImportance(e.target.value.replace(/[^0-9]/g, ''))
              }
              placeholder="重要性 1-10"
            />
            <Input
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              placeholder="触发短语，逗号分隔"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={save} disabled={saving || !content.trim()}>
            {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
