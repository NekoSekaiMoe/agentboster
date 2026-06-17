'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { WorkspacePageHeader } from '@/components/workspace-page-header';
import { useI18n } from '@/components/i18n-provider';
import {
  AlarmClock,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCcw,
  Save,
  Trash2,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { toast } from 'sonner';

import {
  deleteScheduleTaskAction,
  listScheduleTasksAction,
  updateScheduleTaskAction,
} from '@/app/(schedule)/actions';

type TaskType = 'delay' | 'daily';
type DisplayStatus = 'scheduled' | 'archived';

interface ScheduleTask {
  id: string;
  sessionId: string;
  type: TaskType;
  title: string | null;
  prompt: string;
  timezone: string | null;
  dailyTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastFiredFor: string | null;
  scheduleWorkflowRunId: string | null;
  lastChatRunId: string | null;
  active: boolean;
  archived: boolean;
  displayStatus: DisplayStatus;
  createdAt: string;
  updatedAt: string;
}

interface TaskDraft {
  title: string;
  prompt: string;
  type: TaskType;
  active: boolean;
  runAt: string;
  dailyTime: string;
  timezone: string;
}

function toDraft(task: ScheduleTask): TaskDraft {
  return {
    title: task.title ?? '',
    prompt: task.prompt,
    type: task.type,
    active: task.active,
    runAt: toDateTimeLocal(task.nextRunAt),
    dailyTime: task.dailyTime ?? '09:00',
    timezone: task.timezone ?? 'Asia/Shanghai',
  };
}

function toDateTimeLocal(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Not scheduled';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid date';
  }

  return date.toLocaleString();
}

function shortId(value: string | null): string {
  if (!value) {
    return 'None';
  }

  return `${value.slice(0, 8)}…`;
}

export default function SchedulePage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [deletingMap, setDeletingMap] = useState<Record<string, boolean>>({});
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await listScheduleTasksAction();
      const nextTasks = data.tasks ?? [];
      setTasks(nextTasks);
      setDrafts(
        Object.fromEntries(nextTasks.map((task) => [task.id, toDraft(task)])),
      );
      setExpandedTaskId((current) =>
        current && nextTasks.some((task) => task.id === current)
          ? current
          : null,
      );
    } catch {
      toast.error(t('toast.task.scheduleLoadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const scheduledTasks = useMemo(
    () => tasks.filter((task) => task.displayStatus === 'scheduled'),
    [tasks],
  );
  const archivedTasks = useMemo(
    () => tasks.filter((task) => task.displayStatus === 'archived'),
    [tasks],
  );

  const summary = useMemo(
    () => ({
      total: tasks.length,
      scheduled: scheduledTasks.length,
      archived: archivedTasks.length,
      daily: tasks.filter((task) => task.type === 'daily').length,
    }),
    [archivedTasks.length, scheduledTasks.length, tasks],
  );

  function updateDraft(id: string, patch: Partial<TaskDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...patch,
      },
    }));
  }

  async function saveTask(task: ScheduleTask) {
    const draft = drafts[task.id];
    if (!draft || task.archived) {
      return;
    }

    if (!draft.prompt.trim()) {
      toast.error(t('toast.notify.promptEmpty'));
      return;
    }

    if (draft.type === 'delay' && !draft.runAt) {
      toast.error(t('toast.notify.runTimeRequired'));
      return;
    }

    setSavingMap((prev) => ({ ...prev, [task.id]: true }));
    try {
      let body: Record<string, unknown>;
      if (draft.type === 'delay') {
        const runDate = new Date(draft.runAt);
        if (Number.isNaN(runDate.getTime())) {
          toast.error(t('toast.notify.runDateInvalid'));
          setSavingMap((prev) => ({ ...prev, [task.id]: false }));
          return;
        }
        body = {
          type: 'delay',
          title: draft.title.trim() || null,
          prompt: draft.prompt.trim(),
          active: draft.active,
          runAt: runDate.toISOString(),
        };
      } else {
        body = {
          type: 'daily',
          title: draft.title.trim() || null,
          prompt: draft.prompt.trim(),
          active: draft.active,
          dailyTime: draft.dailyTime,
          timezone: draft.timezone.trim() || 'Asia/Shanghai',
        };
      }

      await updateScheduleTaskAction({
        id: task.id,
        task: body as Parameters<typeof updateScheduleTaskAction>[0]['task'],
      });
      toast.success(t('toast.task.updated'));
      await loadTasks();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update task',
      );
    } finally {
      setSavingMap((prev) => ({ ...prev, [task.id]: false }));
    }
  }

  async function deleteTask(id: string) {
    setDeletingMap((prev) => ({ ...prev, [id]: true }));
    try {
      await deleteScheduleTaskAction(id);
      setTasks((prev) => prev.filter((task) => task.id !== id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setExpandedTaskId((current) => (current === id ? null : current));
      toast.success(t('toast.task.deleted'));
    } catch {
      toast.error(t('toast.task.deleteFailed'));
    } finally {
      setDeletingMap((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background pb-16 md:pb-0">
      <WorkspacePageHeader
        title="Schedule"
        description="View, edit, and archive delayed or daily tasks."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => loadTasks()}
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
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-4">
            <SummaryCard
              title="Total Tasks"
              value={String(summary.total)}
              hint="All scheduled tasks"
            />
            <SummaryCard
              title="Scheduled"
              value={String(summary.scheduled)}
              hint="Visible active task cards"
            />
            <SummaryCard
              title="Archived"
              value={String(summary.archived)}
              hint="Completed or expired delay tasks"
            />
            <SummaryCard
              title="Daily"
              value={String(summary.daily)}
              hint="Recurring schedules"
            />
          </div>

          {loading ? (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <Card className="border-border/70">
                  <CardHeader className="pb-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-16" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
                <Card className="border-border/70">
                  <CardHeader className="pb-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-16" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
                <Card className="border-border/70">
                  <CardHeader className="pb-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-16" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
                <Card className="border-border/70">
                  <CardHeader className="pb-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-16" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader className="gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <Skeleton className="size-4" />
                          <Skeleton className="h-5 w-40" />
                          <Skeleton className="h-5 w-16" />
                        </div>
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="size-6" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <Skeleton className="size-4" />
                          <Skeleton className="h-5 w-40" />
                          <Skeleton className="h-5 w-16" />
                        </div>
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="size-6" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  </CardHeader>
                </Card>
              </div>
            </>
          ) : tasks.length === 0 ? (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">No tasks yet</CardTitle>
                <CardDescription>
                  Create one from the `schedule` tool first, then manage it
                  here.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <>
              <TaskSection
                title="Scheduled"
                description="Click a card to expand and edit its details."
                emptyText="No scheduled tasks."
                tasks={scheduledTasks}
                drafts={drafts}
                expandedTaskId={expandedTaskId}
                deletingMap={deletingMap}
                savingMap={savingMap}
                onChange={updateDraft}
                onDelete={deleteTask}
                onSave={saveTask}
                onToggle={setExpandedTaskId}
              />

              <TaskSection
                title="Archived"
                description="Completed or expired delay tasks stay here as collapsed summaries."
                emptyText="No archived tasks."
                tasks={archivedTasks}
                drafts={drafts}
                expandedTaskId={expandedTaskId}
                deletingMap={deletingMap}
                savingMap={savingMap}
                onChange={updateDraft}
                onDelete={deleteTask}
                onSave={saveTask}
                onToggle={setExpandedTaskId}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard(input: { title: string; value: string; hint: string }) {
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardDescription>{input.title}</CardDescription>
        <CardTitle className="text-3xl">{input.value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">{input.hint}</p>
      </CardContent>
    </Card>
  );
}

function TaskSection(input: {
  title: string;
  description: string;
  emptyText: string;
  tasks: ScheduleTask[];
  drafts: Record<string, TaskDraft>;
  expandedTaskId: string | null;
  savingMap: Record<string, boolean>;
  deletingMap: Record<string, boolean>;
  onChange: (id: string, patch: Partial<TaskDraft>) => void;
  onSave: (task: ScheduleTask) => void;
  onDelete: (id: string) => void;
  onToggle: (
    taskId: string | null | ((current: string | null) => string | null),
  ) => void;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-base">{input.title}</h2>
        <p className="text-muted-foreground text-sm">{input.description}</p>
      </div>

      {input.tasks.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-muted-foreground text-sm">
            {input.emptyText}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {input.tasks.map((task) => {
            const draft = input.drafts[task.id];
            if (!draft) {
              return null;
            }

            return (
              <TaskCard
                key={task.id}
                task={task}
                draft={draft}
                expanded={input.expandedTaskId === task.id}
                saving={Boolean(input.savingMap[task.id])}
                deleting={Boolean(input.deletingMap[task.id])}
                onChange={(patch) => input.onChange(task.id, patch)}
                onSave={() => input.onSave(task)}
                onDelete={() => input.onDelete(task.id)}
                onToggle={() =>
                  input.onToggle((current) =>
                    current === task.id ? null : task.id,
                  )
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function TaskCard(input: {
  task: ScheduleTask;
  draft: TaskDraft;
  expanded: boolean;
  saving: boolean;
  deleting: boolean;
  onChange: (patch: Partial<TaskDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const {
    task,
    draft,
    expanded,
    saving,
    deleting,
    onChange,
    onSave,
    onDelete,
    onToggle,
  } = input;
  const archived = task.archived;
  const readOnly = archived;
  const disabled = readOnly || saving || deleting;

  return (
    <Card
      className={
        archived
          ? 'border-border/60 bg-muted/30 opacity-85'
          : task.type === 'daily'
            ? 'border-emerald-200/70 bg-emerald-50/20 dark:border-emerald-900 dark:bg-emerald-950/10'
            : 'border-amber-200/70 bg-amber-50/20 dark:border-amber-900 dark:bg-amber-950/10'
      }
    >
      <button type="button" className="w-full text-left" onClick={onToggle}>
        <CardHeader className={archived ? 'gap-2 py-4' : 'gap-3'}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {task.type === 'daily' ? (
                  <CalendarClock className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlarmClock className="size-4 text-amber-600 dark:text-amber-400" />
                )}
                <CardTitle className={archived ? 'text-sm' : 'text-base'}>
                  {draft.title.trim() || 'Untitled Task'}
                </CardTitle>
                <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs uppercase tracking-wide">
                  {draft.type}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    archived
                      ? 'bg-muted text-muted-foreground'
                      : draft.active
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {archived ? 'archived' : draft.active ? 'active' : 'paused'}
                </span>
              </div>
              <CardDescription>
                Session {shortId(task.sessionId)} · Task {shortId(task.id)}
              </CardDescription>
            </div>

            <span className="rounded-md border bg-background/70 p-1 text-muted-foreground">
              {expanded ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </span>
          </div>

          <div className="grid gap-3 text-muted-foreground text-xs sm:grid-cols-2 xl:grid-cols-4">
            <MetaItem label="Next Run" value={formatDateTime(task.nextRunAt)} />
            <MetaItem
              label="Last Triggered"
              value={formatDateTime(task.lastTriggeredAt)}
            />
            <MetaItem
              label="Schedule Run"
              value={shortId(task.scheduleWorkflowRunId)}
            />
            <MetaItem
              label="Last Chat Run"
              value={shortId(task.lastChatRunId)}
            />
          </div>
        </CardHeader>
      </button>

      {expanded ? (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Title">
              <Input
                disabled={disabled}
                value={draft.title}
                onChange={(event) => onChange({ title: event.target.value })}
                placeholder="Morning brief"
              />
            </Field>

            <Field label="Status">
              <Select
                disabled={disabled}
                value={draft.active ? 'active' : 'paused'}
                onValueChange={(value) =>
                  onChange({ active: value === 'active' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Task Type">
              <Select
                disabled={disabled}
                value={draft.type}
                onValueChange={(value) => onChange({ type: value as TaskType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="delay">Delay</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {draft.type === 'delay' ? (
              <Field label="Run At">
                <Input
                  disabled={disabled}
                  type="datetime-local"
                  value={draft.runAt}
                  onChange={(event) => onChange({ runAt: event.target.value })}
                />
              </Field>
            ) : (
              <>
                <Field label="Daily Time">
                  <Input
                    disabled={disabled}
                    type="time"
                    value={draft.dailyTime}
                    onChange={(event) =>
                      onChange({ dailyTime: event.target.value })
                    }
                  />
                </Field>
                <Field label="Timezone">
                  <Input
                    disabled={disabled}
                    value={draft.timezone}
                    onChange={(event) =>
                      onChange({ timezone: event.target.value })
                    }
                    placeholder="Asia/Shanghai"
                  />
                </Field>
              </>
            )}
          </div>

          <Field label="Prompt">
            <Textarea
              disabled={disabled}
              rows={5}
              value={draft.prompt}
              onChange={(event) => onChange({ prompt: event.target.value })}
              placeholder="What should the agent do when this task fires?"
            />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-muted-foreground text-xs">
              Created {formatDateTime(task.createdAt)} · Updated{' '}
              {formatDateTime(task.updatedAt)}
            </p>

            <div className="flex flex-wrap gap-2">
              {!readOnly ? (
                <Button
                  variant="outline"
                  onClick={onSave}
                  disabled={saving || deleting}
                >
                  {saving ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 size-4" />
                  )}
                  Save
                </Button>
              ) : null}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={saving || deleting}>
                    {deleting ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 size-4" />
                    )}
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes the task and cancels its schedule workflow.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onDelete}>
                      Delete task
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Field(input: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="font-medium text-sm">{input.label}</span>
      {input.children}
    </div>
  );
}

function MetaItem(input: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/70 px-3 py-2">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {input.label}
      </p>
      <p className="mt-1 truncate text-foreground text-sm">{input.value}</p>
    </div>
  );
}
