import { z } from 'zod';

import { parseWithFallback } from '@/lib/core/api/schema';
import type {
  TraceDetail,
  TraceEvent,
  TraceJson,
  TraceSummary,
} from '@/lib/core/trace/aggregate';

const traceSummarySchema = z.object({
  traceId: z.string(),
  sessionId: z.string().nullable().optional(),
  sessionTitle: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  status: z.string(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  modelStepCount: z.number().optional(),
  toolCount: z.number().optional(),
  reviewCount: z.number().optional(),
  failureCount: z.number().optional(),
  totalTokens: z.number().optional(),
  lastError: z.string().nullable().optional(),
});

const traceEventSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  kind: z.string(),
  status: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  step: z.number().nullable().optional(),
  startedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const traceListResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.array(traceSummarySchema),
});

const traceDetailResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    summary: traceSummarySchema,
    events: z.array(traceEventSchema),
  }),
});

function normalizeSummary(
  value: z.infer<typeof traceSummarySchema>,
): TraceSummary {
  return {
    traceId: value.traceId,
    sessionId: value.sessionId ?? null,
    sessionTitle: value.sessionTitle ?? null,
    userId: value.userId ?? null,
    agentId: value.agentId ?? null,
    status: value.status as TraceSummary['status'],
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? null,
    durationMs: value.durationMs ?? null,
    modelStepCount: value.modelStepCount ?? 0,
    toolCount: value.toolCount ?? 0,
    reviewCount: value.reviewCount ?? 0,
    failureCount: value.failureCount ?? 0,
    totalTokens: value.totalTokens ?? 0,
    lastError: value.lastError ?? null,
  };
}

function normalizeEvent(value: z.infer<typeof traceEventSchema>): TraceEvent {
  return {
    id: value.id,
    traceId: value.traceId,
    kind: value.kind as TraceEvent['kind'],
    status: value.status as TraceEvent['status'],
    title: value.title,
    subtitle: value.subtitle ?? null,
    step: value.step ?? null,
    startedAt: value.startedAt,
    completedAt: value.completedAt ?? null,
    durationMs: value.durationMs ?? null,
    details: (value.details ?? {}) as TraceJson,
  };
}

export async function fetchTraces(
  filters: { search?: string; limit?: number } = {},
): Promise<TraceSummary[]> {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.limit) params.set('limit', String(filters.limit));
  const response = await fetch(`/api/config/traces?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch traces');
  const payload = parseWithFallback(
    await response.json().catch(() => ({})),
    traceListResponseSchema,
    { success: false, data: [] },
    { endpoint: 'GET /api/config/traces' },
  );
  return payload.data.map(normalizeSummary);
}

export async function fetchTrace(traceId: string): Promise<TraceDetail | null> {
  const response = await fetch(
    `/api/config/traces/${encodeURIComponent(traceId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Failed to fetch trace');
  const payload = parseWithFallback(
    await response.json().catch(() => ({})),
    traceDetailResponseSchema,
    { success: false, data: { summary: null, events: [] } },
    { endpoint: 'GET /api/config/traces/:traceId' },
  );
  if (!payload.data?.summary) return null;
  return {
    summary: normalizeSummary(payload.data.summary),
    events: payload.data.events.map(normalizeEvent),
  };
}
