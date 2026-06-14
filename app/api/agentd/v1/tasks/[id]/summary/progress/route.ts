import { randomUUID } from 'node:crypto';
import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  getTaskSummary,
  requireTaskAccess,
  upsertTaskSummary,
} from '@/lib/core/db/agentd';
import type { Decision } from '@/lib/core/db/schema';

type DecisionInput = {
  description?: unknown;
  reason?: unknown;
  alternatives?: unknown;
};

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function removeItems(items: string[], removals: string[]) {
  if (removals.length === 0) {
    return items;
  }

  const removalSet = new Set(removals);
  return items.filter((item) => !removalSet.has(item));
}

function normalizeDecision(input: unknown): Decision | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const decision = input as DecisionInput;
  if (
    typeof decision.description !== 'string' ||
    typeof decision.reason !== 'string'
  ) {
    return null;
  }

  return {
    id: `dec_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    description: decision.description,
    reason: decision.reason,
    alternatives: asStringArray(decision.alternatives),
  };
}

function statusValue(value: unknown) {
  return value === 'active' || value === 'paused' || value === 'completed'
    ? value
    : undefined;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const decision = normalizeDecision(body.decision);

  try {
    const task = await requireTaskAccess({
      taskId: id,
      sessionId:
        typeof body.session_id === 'string' ? body.session_id : undefined,
    });
    const existing = await getTaskSummary(id);

    const summary = await upsertTaskSummary({
      taskId: id,
      agentId: task.agentId,
      sessionId: task.sessionId,
      status: statusValue(body.status) ?? existing?.status ?? 'active',
      progress:
        typeof body.progress === 'string'
          ? body.progress
          : (existing?.progress ?? undefined),
      decisions: decision
        ? [...(existing?.decisions ?? []), decision]
        : (existing?.decisions ?? undefined),
      pending: [
        ...removeItems(
          existing?.pending ?? [],
          asStringArray(body.pending_done),
        ),
        ...asStringArray(body.pending_add),
      ],
      knownIssues: [
        ...removeItems(
          existing?.knownIssues ?? [],
          asStringArray(body.known_issue_resolve),
        ),
        ...asStringArray(body.known_issue_add),
      ],
    });

    return Response.json({ success: true, data: summary });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
