import type { TraceEnvelopeBase } from './dal';

export type TraceCallbackKind = 'run' | 'span' | 'event';

export type NormalizedTraceCallback = {
  kind: TraceCallbackKind;
  envelope: TraceEnvelopeBase & {
    eventId?: string;
  };
  taskId: string | null;
  sessionId: string | null;
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Explicit compatibility adapter for agentd callbacks. Legacy activity and
 * review payloads intentionally do not enter this function; callers can
 * route them to their existing domain writers during the dual-write window.
 */
export function normalizeTraceCallback(
  value: unknown,
): NormalizedTraceCallback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const kindValue = stringValue(
    body.record_kind ?? body.recordKind ?? body.kind,
  );
  const kind: TraceCallbackKind | null =
    kindValue === 'run' || kindValue === 'span' || kindValue === 'event'
      ? kindValue
      : null;
  const hasCanonicalIdentity =
    Boolean(stringValue(body.span_id ?? body.spanId)) ||
    Boolean(stringValue(body.event_id ?? body.eventId)) ||
    Boolean(kind);
  if (!hasCanonicalIdentity) return null;

  const traceId = stringValue(body.trace_id ?? body.traceId);
  const idempotencyKey = stringValue(
    body.idempotency_key ?? body.idempotencyKey,
  );
  const source = stringValue(body.source) ?? 'agentd';
  const type = stringValue(body.type ?? body.event_type ?? body.eventType);
  if (!traceId || !idempotencyKey || !type) return null;

  const resolvedKind = kind ?? (type === 'event' ? 'event' : 'span');
  return {
    kind: resolvedKind,
    taskId: stringValue(body.task_id ?? body.taskId),
    sessionId: stringValue(body.session_id ?? body.sessionId),
    envelope: {
      traceId,
      eventId: stringValue(body.event_id ?? body.eventId) ?? undefined,
      spanId: stringValue(body.span_id ?? body.spanId),
      parentSpanId: stringValue(body.parent_span_id ?? body.parentSpanId),
      source,
      type,
      status: stringValue(body.status) ?? 'pending',
      startedAt: dateValue(body.started_at ?? body.startedAt),
      completedAt: dateValue(body.completed_at ?? body.completedAt) ?? null,
      durationMs:
        typeof body.duration_ms === 'number'
          ? body.duration_ms
          : typeof body.durationMs === 'number'
            ? body.durationMs
            : null,
      sessionId: stringValue(body.session_id ?? body.sessionId),
      taskId: stringValue(body.task_id ?? body.taskId),
      nodeId: stringValue(body.node_id ?? body.nodeId),
      agentId: stringValue(body.agent_id ?? body.agentId),
      input: body.input,
      output: body.output,
      error: body.error,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : null,
      idempotencyKey,
    },
  };
}
