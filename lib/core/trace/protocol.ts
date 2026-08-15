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

/** Normalize canonical callbacks and the short-lived agentd compatibility shape. */
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

  const traceId = stringValue(
    body.trace_id ?? body.traceId ?? body.run_id ?? body.runId,
  );
  let idempotencyKey = stringValue(body.idempotency_key ?? body.idempotencyKey);
  const source = stringValue(body.source) ?? 'agentd';
  let type = stringValue(body.type ?? body.event_type ?? body.eventType);
  const legacyReview = !hasCanonicalIdentity && Boolean(body.command);
  const legacyTool =
    !hasCanonicalIdentity && Boolean(body.tool_name ?? body.toolName);
  if (!hasCanonicalIdentity && !legacyReview && !legacyTool) return null;
  if (legacyReview || legacyTool) {
    type = legacyReview ? 'review' : 'tool';
    idempotencyKey ??= legacyReview
      ? `review:${stringValue(body.task_id ?? body.taskId) ?? 'unknown'}:${stringValue(body.level) ?? 'unknown'}:${stringValue(body.decision) ?? 'unknown'}:${stringValue(body.command) ?? ''}`
      : `tool:${stringValue(body.task_id ?? body.taskId) ?? 'unknown'}:${stringValue(body.tool_call_id ?? body.toolCallId) ?? stringValue(body.tool_name ?? body.toolName) ?? 'unknown'}:${stringValue(body.started_at ?? body.startedAt) ?? ''}`;
  }
  if (!traceId || !idempotencyKey || !type) return null;

  const resolvedKind = kind ?? (type === 'event' ? 'event' : 'span');
  // Canonical records must carry their own identity: events need an
  // event_id and runs need a span_id. Legacy auto-generated payloads keep
  // the synthesized ids.
  if (hasCanonicalIdentity) {
    if (
      resolvedKind === 'event' &&
      !stringValue(body.event_id ?? body.eventId)
    ) {
      return null;
    }
    if (resolvedKind === 'run' && !stringValue(body.span_id ?? body.spanId)) {
      return null;
    }
  }
  const taskId = stringValue(body.task_id ?? body.taskId);
  const sessionId = stringValue(body.session_id ?? body.sessionId);
  const metadata =
    body.metadata && typeof body.metadata === 'object'
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
  if (legacyReview) {
    Object.assign(metadata, {
      command: stringValue(body.command) ?? '',
      level: stringValue(body.level) ?? 'unknown',
      score: typeof body.score === 'number' ? body.score : null,
      decision: stringValue(body.decision) ?? 'unknown',
      reason: stringValue(body.reason),
    });
  }
  if (legacyTool) {
    Object.assign(metadata, {
      toolName: stringValue(body.tool_name ?? body.toolName) ?? 'unknown',
      action: stringValue(body.action) ?? 'other',
      target: stringValue(body.target),
      outputText: stringValue(body.output_text ?? body.outputText),
    });
  }
  return {
    kind: resolvedKind,
    taskId,
    sessionId,
    envelope: {
      traceId,
      eventId: stringValue(body.event_id ?? body.eventId) ?? undefined,
      spanId:
        stringValue(body.span_id ?? body.spanId) ??
        (legacyReview
          ? `review:${idempotencyKey}`
          : legacyTool
            ? `tool:${idempotencyKey}`
            : null),
      parentSpanId: stringValue(body.parent_span_id ?? body.parentSpanId),
      source,
      type,
      status:
        stringValue(body.status) ??
        (legacyReview
          ? (stringValue(body.decision) ?? 'completed')
          : legacyTool
            ? body.success === false
              ? 'failed'
              : 'completed'
            : 'pending'),
      startedAt: dateValue(body.started_at ?? body.startedAt),
      completedAt: dateValue(body.completed_at ?? body.completedAt) ?? null,
      durationMs:
        typeof body.duration_ms === 'number'
          ? body.duration_ms
          : typeof body.durationMs === 'number'
            ? body.durationMs
            : null,
      sessionId,
      taskId,
      nodeId: stringValue(body.node_id ?? body.nodeId),
      agentId: stringValue(body.agent_id ?? body.agentId),
      input: body.input ?? body.arguments,
      output: body.output ?? body.result,
      error: body.error,
      metadata,
      idempotencyKey,
    },
  };
}
