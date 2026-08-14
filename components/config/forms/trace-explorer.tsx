'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  CircleX,
  Clock3,
  Copy,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { fetchTrace, fetchTraces } from '@/lib/core/api/traces';
import type {
  TraceDetail,
  TraceEvent,
  TraceStatus,
  TraceSummary,
} from '@/lib/core/trace/aggregate';
import type { TranslationKey } from '@/lib/i18n';

type Translate = ReturnType<typeof useI18n>['t'];

const statusClass: Record<TraceStatus, string> = {
  running:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200',
  completed:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  stopped:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  unknown: 'border-muted bg-muted/50 text-muted-foreground',
};

const eventStatusClass: Record<string, string> = {
  completed:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed:
    'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  running:
    'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200',
  pending:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  unknown: 'border-muted bg-muted text-muted-foreground',
};

const statusLabelKeys: Partial<Record<string, TranslationKey>> = {
  running: 'config.trace.status.running',
  completed: 'config.trace.status.completed',
  failed: 'config.trace.status.failed',
  stopped: 'config.trace.status.stopped',
  unknown: 'config.trace.status.unknown',
  pending: 'config.trace.status.pending',
};

const eventKindLabelKeys: Record<TraceEvent['kind'], TranslationKey> = {
  model: 'config.trace.kind.model',
  tool: 'config.trace.kind.tool',
  review: 'config.trace.kind.review',
};

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatTime(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function shortId(value: string | null): string {
  if (!value) return '-';
  return value.length > 22
    ? `${value.slice(0, 10)}...${value.slice(-8)}`
    : value;
}

function safeJson(value: unknown, truncatedLabel: string): string {
  try {
    const output = JSON.stringify(value, null, 2) ?? String(value);
    return output.length > 12_000
      ? `${output.slice(0, 12_000)}\n... ${truncatedLabel}`
      : output;
  } catch {
    return String(value);
  }
}

function statusLabel(t: Translate, status: string): string {
  const key = statusLabelKeys[status];
  return key ? t(key) : status;
}

function eventTitle(t: Translate, event: TraceEvent): string {
  if (event.kind === 'model') {
    return event.step === null
      ? t('config.trace.modelStep')
      : t('config.trace.modelStepNumber', { step: event.step + 1 });
  }
  if (event.kind === 'review') {
    const level =
      typeof event.details.level === 'string' ? event.details.level : '';
    return t('config.trace.securityReview', { level });
  }
  return event.title;
}

function eventSubtitle(t: Translate, event: TraceEvent): string {
  if (event.kind === 'model') {
    const finishReason = event.details.finishReason;
    return typeof finishReason === 'string' && finishReason.length > 0
      ? t('config.trace.finishReason', { reason: finishReason })
      : t('config.trace.inProgress');
  }
  return event.subtitle || t(eventKindLabelKeys[event.kind]);
}

function StatusBadge({ status, t }: { status: string; t: Translate }) {
  return (
    <Badge
      className={statusClass[status as TraceStatus] ?? statusClass.unknown}
    >
      {statusLabel(t, status)}
    </Badge>
  );
}

function EventIcon({ kind }: { kind: TraceEvent['kind'] }) {
  if (kind === 'model') return <Bot className="h-3.5 w-3.5" />;
  if (kind === 'review') return <ShieldCheck className="h-3.5 w-3.5" />;
  return <Wrench className="h-3.5 w-3.5" />;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="h-8 w-8"
          onClick={onClick}
          size="icon"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 border-l px-3 first:border-l-0">
      <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-medium text-sm">{value}</dd>
    </div>
  );
}

function TraceListRow({
  trace,
  selected,
  onSelect,
  t,
}: {
  trace: TraceSummary;
  selected: boolean;
  onSelect: () => void;
  t: Translate;
}) {
  return (
    <button
      className={`w-full border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${selected ? 'bg-muted' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{shortId(trace.traceId)}</span>
        </span>
        <StatusBadge status={trace.status} t={t} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="truncate">
          {trace.sessionTitle || shortId(trace.sessionId)}
        </span>
        <span className="shrink-0">{formatDuration(trace.durationMs)}</span>
      </div>
      <div className="mt-1 flex gap-3 text-[11px] text-muted-foreground">
        <span>
          {t('config.trace.modelCount', { count: trace.modelStepCount })}
        </span>
        <span>{t('config.trace.toolCount', { count: trace.toolCount })}</span>
        <span>
          {t('config.trace.failureCount', { count: trace.failureCount })}
        </span>
      </div>
    </button>
  );
}

function TraceEventRow({ event, t }: { event: TraceEvent; t: Translate }) {
  return (
    <details className="group relative border-b px-4 py-3 last:border-b-0">
      <summary className="grid cursor-pointer list-none grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="relative mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
          <EventIcon kind={event.kind} />
          <span className="absolute top-5 left-1/2 h-7 w-px -translate-x-1/2 bg-border group-last:hidden" />
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-sm">
              {eventTitle(t, event)}
            </span>
            <Badge
              className={
                eventStatusClass[event.status] ?? eventStatusClass.unknown
              }
            >
              {statusLabel(t, event.status)}
            </Badge>
          </span>
          <span className="mt-1 block truncate text-muted-foreground text-xs">
            {eventSubtitle(t, event)}
          </span>
        </span>
        <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground text-xs">
          <span>{formatDuration(event.durationMs)}</span>
          <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
        </span>
      </summary>
      <div className="mt-3 ml-[34px] grid gap-3 text-xs">
        <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
          <span>
            {t('config.trace.startedAt', { time: formatTime(event.startedAt) })}
          </span>
          <span>
            {t('config.trace.completedAt', {
              time: formatTime(event.completedAt),
            })}
          </span>
        </div>
        {Object.keys(event.details).length > 0 && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
            {safeJson(event.details, t('config.trace.outputTruncated'))}
          </pre>
        )}
      </div>
    </details>
  );
}

function TraceDetailPanel({
  detail,
  isLoading,
  error,
  t,
}: {
  detail: TraceDetail | null | undefined;
  isLoading: boolean;
  error: Error | null;
  t: Translate;
}) {
  if (isLoading) {
    return (
      <div className="flex min-h-[520px] items-center justify-center text-muted-foreground text-sm">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        {t('config.trace.loadingDetail')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
        <CircleX className="h-5 w-5 text-destructive" />
        {t('config.trace.loadDetailFailed')}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex min-h-[520px] items-center justify-center p-6 text-muted-foreground text-sm">
        {t('config.trace.selectPrompt')}
      </div>
    );
  }

  const { summary, events } = detail;
  return (
    <div className="min-w-0">
      <div className="border-b px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <code className="truncate font-mono text-sm">
                {summary.traceId}
              </code>
            </div>
            <p className="mt-1 truncate text-muted-foreground text-xs">
              {summary.sessionTitle || shortId(summary.sessionId)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <StatusBadge status={summary.status} t={t} />
            <IconButton
              label={t('config.trace.copyId')}
              onClick={() => copyText(summary.traceId)}
            >
              <Copy />
            </IconButton>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-y-3 sm:grid-cols-5">
          <Metric
            label={t('config.trace.metric.started')}
            value={formatTime(summary.startedAt)}
          />
          <Metric
            label={t('config.trace.metric.duration')}
            value={formatDuration(summary.durationMs)}
          />
          <Metric
            label={t('config.trace.metric.model')}
            value={summary.modelStepCount}
          />
          <Metric
            label={t('config.trace.metric.tools')}
            value={summary.toolCount}
          />
          <Metric
            label={t('config.trace.metric.reviews')}
            value={summary.reviewCount}
          />
        </dl>
        {summary.lastError && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-xs dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{summary.lastError}</span>
          </div>
        )}
      </div>
      <div className="border-b bg-muted/20 px-4 py-2 text-muted-foreground text-xs">
        {t('config.trace.eventsOrdered', { count: events.length })}
      </div>
      {events.length === 0 ? (
        <div className="flex min-h-[360px] items-center justify-center p-6 text-muted-foreground text-sm">
          {t('config.trace.noEvents')}
        </div>
      ) : (
        <div>
          {events.map((event) => (
            <TraceEventRow event={event} key={event.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TraceExplorer() {
  const { t } = useI18n();
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const tracesQuery = useQuery({
    queryKey: ['traces', search],
    queryFn: () => fetchTraces({ search, limit: 100 }),
    refetchInterval: 10_000,
  });
  const traces = tracesQuery.data ?? [];
  const activeTraceId = useMemo(
    () =>
      selectedTraceId &&
      traces.some((trace) => trace.traceId === selectedTraceId)
        ? selectedTraceId
        : (traces[0]?.traceId ?? null),
    [selectedTraceId, traces],
  );
  const detailQuery = useQuery({
    queryKey: ['trace', activeTraceId],
    queryFn: () => fetchTrace(activeTraceId as string),
    enabled: Boolean(activeTraceId),
    refetchInterval: (query) =>
      query.state.data?.summary.status === 'running' ? 3_000 : false,
  });

  const applySearch = () => setSearch(searchDraft.trim());

  return (
    <TooltipProvider>
      <section className="overflow-hidden rounded-md border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">{t('config.trace.title')}</h3>
          </div>
          <IconButton
            label={t('config.trace.refresh')}
            onClick={() => void tracesQuery.refetch()}
          >
            <RefreshCw
              className={tracesQuery.isFetching ? 'animate-spin' : ''}
            />
          </IconButton>
        </div>
        <div className="border-b px-4 py-3">
          <div className="flex max-w-xl gap-2">
            <Input
              aria-label={t('config.trace.searchLabel')}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySearch();
              }}
              placeholder={t('config.trace.searchPlaceholder')}
              value={searchDraft}
            />
            <Button
              aria-label={t('config.trace.searchLabel')}
              onClick={applySearch}
              size="icon"
              variant="outline"
            >
              <Search />
            </Button>
          </div>
        </div>
        <div className="grid min-h-[560px] lg:grid-cols-[minmax(260px,0.75fr)_minmax(0,1.65fr)]">
          <div className="max-h-[680px] overflow-y-auto border-b lg:border-r lg:border-b-0">
            {tracesQuery.isLoading ? (
              <div className="flex min-h-[280px] items-center justify-center text-muted-foreground text-sm">
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                {t('config.trace.loadingList')}
              </div>
            ) : tracesQuery.isError ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
                <CircleX className="h-5 w-5 text-destructive" />
                {t('config.trace.loadListFailed')}
              </div>
            ) : traces.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
                <Clock3 className="h-5 w-5" />
                {t('config.trace.noTraces')}
              </div>
            ) : (
              traces.map((trace) => (
                <TraceListRow
                  key={trace.traceId}
                  onSelect={() => setSelectedTraceId(trace.traceId)}
                  selected={trace.traceId === activeTraceId}
                  trace={trace}
                  t={t}
                />
              ))
            )}
          </div>
          <TraceDetailPanel
            detail={detailQuery.data}
            error={
              detailQuery.error instanceof Error ? detailQuery.error : null
            }
            isLoading={detailQuery.isLoading}
            t={t}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}
