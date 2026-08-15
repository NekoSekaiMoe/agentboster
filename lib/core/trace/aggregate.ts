export type TraceStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown';

export type TraceJson = Record<string, unknown>;

export interface TraceModelRow {
  id: string;
  traceId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  userId: string | null;
  role: string;
  stepNumber: number | null;
  payload: TraceJson;
  createdAt: Date | string;
  sequence?: number;
  hint?: TraceStatusHint;
}

export interface TraceToolRow {
  id: string;
  traceId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  userId: string | null;
  agentId: string;
  toolName: string;
  action: string;
  target: string | null;
  arguments: unknown;
  result: unknown;
  outputText: string | null;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
  sequence?: number;
  hint?: TraceStatusHint;
}

export interface TraceReviewRow {
  id: string;
  traceId: string;
  taskId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  userId: string | null;
  agentId: string | null;
  level: string;
  decision: string;
  score: number | null;
  command: string;
  reason: string | null;
  createdAt: Date | string;
  sequence?: number;
  hint?: TraceStatusHint;
}

export interface TraceStatusHint {
  currentRunId?: string | null;
  lastRunId?: string | null;
  phase?: string | null;
  stoppedAt?: Date | string | null;
  lastError?: string | null;
  workflowStatus?: string | null;
}

export interface TraceEvent {
  id: string;
  traceId: string;
  kind: 'model' | 'tool' | 'review';
  status: TraceStatus | 'pending';
  title: string;
  subtitle: string | null;
  step: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  details: TraceJson;
  /** Canonical store ordering key. Legacy rows omit it and use timestamps. */
  sequence?: number;
}

export interface TraceSummary {
  traceId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  userId: string | null;
  agentId: string | null;
  status: TraceStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  modelStepCount: number;
  toolCount: number;
  reviewCount: number;
  failureCount: number;
  totalTokens: number;
  lastError: string | null;
}

export interface TraceDetail {
  summary: TraceSummary;
  events: TraceEvent[];
}

export interface TraceRows {
  traceId: string;
  run?: {
    startedAt: Date | string;
    completedAt: Date | string | null;
    durationMs: number | null;
    /** Run-level identity: the fallback used by buildTraceSummary when a
     * trace has no model/tool/review spans (e.g. events-only runs). */
    sessionId?: string | null;
    sessionTitle?: string | null;
    userId?: string | null;
    agentId?: string | null;
  };
  models?: TraceModelRow[];
  tools?: TraceToolRow[];
  reviews?: TraceReviewRow[];
  events?: TraceEvent[];
  hint?: TraceStatusHint;
}

function asRecord(value: unknown): TraceJson {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TraceJson)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function minIso(
  values: Array<Date | string | null | undefined>,
): string | null {
  const valid = values
    .map((value) => asIso(value))
    .filter((value): value is string => value !== null)
    .sort();
  return valid[0] ?? null;
}

function maxIso(
  values: Array<Date | string | null | undefined>,
): string | null {
  const valid = values
    .map((value) => asIso(value))
    .filter((value): value is string => value !== null)
    .sort();
  return valid.at(-1) ?? null;
}

function durationMs(
  startedAt: string | null,
  completedAt: string | null,
  explicit: number | null = null,
): number | null {
  if (explicit !== null) return Math.max(0, Math.round(explicit));
  if (!startedAt || !completedAt) return null;
  return Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  );
}

function modelEventStatus(finishReason: string | null): TraceStatus {
  if (!finishReason) return 'running';
  if (finishReason === 'stop' || finishReason === 'length') return 'completed';
  if (finishReason.toLowerCase().includes('error')) return 'failed';
  return 'completed';
}

function reviewEventStatus(decision: string): TraceEvent['status'] {
  const normalized = decision.toLowerCase();
  if (
    normalized === 'blocked' ||
    normalized === 'rejected' ||
    normalized === 'expired'
  ) {
    return 'failed';
  }
  if (normalized.includes('pending')) return 'pending';
  return 'completed';
}

function hintStatus(
  traceId: string,
  hint?: TraceStatusHint,
): TraceStatus | null {
  if (!hint) return null;
  if (hint.workflowStatus) {
    const status = hint.workflowStatus.toLowerCase();
    if (status === 'running' || status === 'pending') return 'running';
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'error') return 'failed';
    if (
      status === 'cancelled' ||
      status === 'canceled' ||
      status === 'stopped'
    ) {
      return 'stopped';
    }
  }
  if (hint.currentRunId === traceId) return 'running';
  if (hint.lastRunId === traceId) {
    switch (hint.phase) {
      case 'completed':
        return 'completed';
      case 'error':
        return 'failed';
      case 'cancelled':
        return 'stopped';
      case 'running':
        return 'running';
    }
  }
  return null;
}

function eventStatus(events: TraceEvent[]): TraceStatus {
  const modelEvents = events.filter((event) => event.kind === 'model');
  if (modelEvents.some((event) => event.status === 'failed')) return 'failed';
  if (modelEvents.some((event) => event.status === 'completed')) {
    return 'completed';
  }
  if (modelEvents.length > 0) return 'unknown';

  const fallbackEvents = events.filter(
    (event) =>
      event.kind !== 'model' &&
      (event.status === 'completed' || event.status === 'failed'),
  );
  if (fallbackEvents.length === 0) return 'unknown';
  return fallbackEvents.every((event) => event.status === 'failed')
    ? 'failed'
    : 'completed';
}

function groupSequence(group: TraceModelRow[]): number | undefined {
  const sequences = group
    .map((row) => row.sequence)
    .filter((value): value is number => typeof value === 'number');
  return sequences.length ? Math.min(...sequences) : undefined;
}

function buildModelEvents(
  traceId: string,
  rows: TraceModelRow[],
): TraceEvent[] {
  const groups = new Map<string, TraceModelRow[]>();
  for (const row of rows) {
    const key = String(row.stepNumber ?? 'unknown');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    const preferred = group.find((row) => row.role === 'assistant') ?? group[0];
    const payload = asRecord(preferred.payload);
    const metadata = asRecord(payload.metadata);
    const finishReason =
      asString(payload.finishReason) ?? asString(metadata.finishReason);
    const startedAt = minIso(group.map((row) => row.createdAt));
    const completedAt = maxIso(
      group.map((row) =>
        asString(asRecord(asRecord(row.payload).metadata).traceCompletedAt),
      ),
    );
    const explicitDuration = asNumber(metadata.traceDurationMs);
    const step = preferred.stepNumber;
    const usage = asRecord(payload.usage);
    const totalTokens = asNumber(usage.totalTokens) ?? 0;

    return {
      id: `model:${traceId}:${key}:${preferred.id}`,
      traceId,
      kind: 'model',
      status: modelEventStatus(finishReason),
      title: step === null ? 'Model step' : `Model step ${step + 1}`,
      subtitle: finishReason ? `finish: ${finishReason}` : 'in progress',
      step,
      startedAt: startedAt ?? new Date(0).toISOString(),
      completedAt,
      durationMs: durationMs(startedAt, completedAt, explicitDuration),
      details: {
        text: asString(payload.text),
        reasoning: asString(payload.reasoningText),
        finishReason,
        usage,
        totalTokens,
        rowCount: group.length,
      },
      sequence: groupSequence(group),
    } satisfies TraceEvent;
  });
}

function buildToolEvents(traceId: string, rows: TraceToolRow[]): TraceEvent[] {
  return rows.map((row) => ({
    id: `tool:${row.id}`,
    traceId,
    kind: 'tool',
    status: row.success ? 'completed' : 'failed',
    title: row.toolName,
    subtitle: row.target || row.action || null,
    step: null,
    startedAt: asIso(row.startedAt) ?? new Date(0).toISOString(),
    completedAt: asIso(row.completedAt),
    durationMs: durationMs(
      asIso(row.startedAt),
      asIso(row.completedAt),
      row.durationMs,
    ),
    details: {
      action: row.action,
      target: row.target,
      arguments: row.arguments,
      result: row.result,
      outputText: row.outputText,
      error: row.error,
      agentId: row.agentId,
      sessionId: row.sessionId,
    },
    sequence: row.sequence,
  }));
}

function buildReviewEvents(
  traceId: string,
  rows: TraceReviewRow[],
): TraceEvent[] {
  return rows.map((row) => {
    const status = reviewEventStatus(row.decision);
    return {
      id: `review:${row.id}`,
      traceId,
      kind: 'review',
      status,
      title: `Security review ${row.level}`,
      subtitle: row.decision,
      step: null,
      startedAt: asIso(row.createdAt) ?? new Date(0).toISOString(),
      completedAt: asIso(row.createdAt),
      durationMs: 0,
      details: {
        command: row.command,
        level: row.level,
        decision: row.decision,
        score: row.score,
        reason: row.reason,
        taskId: row.taskId,
        agentId: row.agentId,
        sessionId: row.sessionId,
      },
      sequence: row.sequence,
    } satisfies TraceEvent;
  });
}

export function buildTraceEvents(rows: TraceRows): TraceEvent[] {
  return [
    ...buildModelEvents(rows.traceId, rows.models ?? []),
    ...buildToolEvents(rows.traceId, rows.tools ?? []),
    ...buildReviewEvents(rows.traceId, rows.reviews ?? []),
    ...(rows.events ?? []),
  ].sort((left, right) => {
    // Global lexicographic order: (startedAt, sequence, id).
    // A single consistent key ordering keeps the comparator transitive even
    // when canonical rows (with sequence) mix with legacy rows (without).
    // The previous hybrid ("sequence diff when both sides have one, else
    // startedAt") violated transitivity: A(seq=1, late), B(no seq, mid),
    // C(seq=2, early) yielded C < B < A while A < C.
    // Canonical records that share a startedAt are refined by sequence
    // (missing sequence sorts last: +Infinity), then id for determinism.
    const timeDiff = left.startedAt.localeCompare(right.startedAt);
    if (timeDiff !== 0) return timeDiff;
    const leftSequence = left.sequence ?? Number.POSITIVE_INFINITY;
    const rightSequence = right.sequence ?? Number.POSITIVE_INFINITY;
    if (leftSequence !== rightSequence) {
      return leftSequence < rightSequence ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export function buildTraceSummary(
  rows: TraceRows,
  events = buildTraceEvents(rows),
): TraceSummary {
  const models = rows.models ?? [];
  const tools = rows.tools ?? [];
  const reviews = rows.reviews ?? [];
  const firstModel = models[0];
  const firstTool = tools[0];
  const firstReview = reviews[0];
  const hint =
    rows.hint ?? firstModel?.hint ?? firstTool?.hint ?? firstReview?.hint;
  const startedAt = minIso([
    rows.run?.startedAt,
    ...models.map((row) => row.createdAt),
    ...tools.map((row) => row.startedAt),
    ...reviews.map((row) => row.createdAt),
  ]);
  const latestCompletedAt = maxIso(events.map((event) => event.completedAt));
  const statusFromHint = hintStatus(rows.traceId, hint);
  const status = statusFromHint ?? eventStatus(events);
  const completedAt =
    status === 'running'
      ? null
      : (asIso(hint?.stoppedAt) ??
        asIso(rows.run?.completedAt) ??
        latestCompletedAt);
  const failedEvents = events.filter((event) => event.status === 'failed');
  const lastFailure = failedEvents.at(-1);
  const details = lastFailure?.details ?? {};
  const totalTokens = events.reduce((total, event) => {
    const value = asNumber(event.details.totalTokens);
    return total + (value ?? 0);
  }, 0);
  const firstSessionId =
    firstModel?.sessionId ??
    firstTool?.sessionId ??
    firstReview?.sessionId ??
    rows.run?.sessionId ??
    null;
  const sessionTitle =
    firstModel?.sessionTitle ??
    firstTool?.sessionTitle ??
    firstReview?.sessionTitle ??
    rows.run?.sessionTitle ??
    null;
  const userId =
    firstModel?.userId ??
    firstTool?.userId ??
    firstReview?.userId ??
    rows.run?.userId ??
    null;
  const agentId =
    firstTool?.agentId ?? firstReview?.agentId ?? rows.run?.agentId ?? null;

  return {
    traceId: rows.traceId,
    sessionId: firstSessionId,
    sessionTitle,
    userId,
    agentId,
    status,
    startedAt,
    completedAt,
    durationMs:
      status === 'running'
        ? durationMs(startedAt, new Date().toISOString())
        : durationMs(startedAt, completedAt, rows.run?.durationMs),
    modelStepCount: new Set(
      models.map((row) => String(row.stepNumber ?? 'unknown')),
    ).size,
    toolCount: tools.length,
    reviewCount: reviews.length,
    failureCount: failedEvents.length,
    totalTokens,
    lastError:
      asString(hint?.lastError) ??
      asString(details.error) ??
      asString(details.reason) ??
      null,
  };
}

export function buildTraceDetail(rows: TraceRows): TraceDetail {
  const events = buildTraceEvents(rows);
  return {
    summary: buildTraceSummary(rows, events),
    events,
  };
}

export function mergeTraceRows(groups: TraceRows[]): TraceRows[] {
  const merged = new Map<string, TraceRows>();
  for (const group of groups) {
    const current = merged.get(group.traceId) ?? { traceId: group.traceId };
    current.models = [...(current.models ?? []), ...(group.models ?? [])];
    current.tools = [...(current.tools ?? []), ...(group.tools ?? [])];
    current.reviews = [...(current.reviews ?? []), ...(group.reviews ?? [])];
    current.events = [...(current.events ?? []), ...(group.events ?? [])];
    current.run = current.run ?? group.run;
    current.hint = current.hint ?? group.hint;
    merged.set(group.traceId, current);
  }
  return [...merged.values()];
}
