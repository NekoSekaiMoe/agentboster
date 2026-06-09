import { randomUUID } from 'node:crypto';
import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  getTaskSummary,
  requireTaskAccess,
  upsertTaskSummary,
} from '@/lib/core/db/agentd';
import type { Decision } from '@/lib/core/db/schema';

type DecisionUpdate = {
  id: string;
  description?: string;
  reason?: string;
  alternatives?: string[];
};

function ensureDecisionIds(decisions: Decision[]) {
  return decisions.map((decision) => ({
    ...decision,
    id: decision.id ?? `dec_${randomUUID()}`,
  }));
}

function matchesDecisionId(decision: Decision, index: number, id: string) {
  if (id.startsWith('decision:')) {
    return id === `decision:${index}`;
  }

  return decision.id === id;
}

function removeItems(items: string[], removals: string[]) {
  if (removals.length === 0) {
    return items;
  }

  const removalSet = new Set(removals);
  return items.filter((item) => !removalSet.has(item));
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asUpdates(value: unknown): DecisionUpdate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string',
    )
    .map((item) => ({
      id: item.id as string,
      ...(typeof item.description === 'string' && {
        description: item.description,
      }),
      ...(typeof item.reason === 'string' && { reason: item.reason }),
      ...(Array.isArray(item.alternatives) && {
        alternatives: item.alternatives.filter(
          (alternative): alternative is string =>
            typeof alternative === 'string',
        ),
      }),
    }));
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireTaskAccess({ taskId: id });
    const summary = await getTaskSummary(id);

    if (!summary) {
      return Response.json(
        { success: false, error: 'Task summary not found' },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const expectedLastUpdated =
      typeof body.summary_last_updated === 'string'
        ? body.summary_last_updated
        : null;

    if (!expectedLastUpdated) {
      return Response.json(
        { success: false, error: 'summary_last_updated is required' },
        { status: 400 },
      );
    }

    if (summary.lastUpdated.toISOString() !== expectedLastUpdated) {
      return Response.json(
        {
          success: false,
          error: 'Task summary changed since tidy report was generated',
        },
        { status: 409 },
      );
    }

    const mergeIds = asStringArray(body.merge_ids);
    const deleteIds = new Set(asStringArray(body.delete_ids));
    const updates = asUpdates(body.update_ids);

    if (mergeIds.length > 0 && updates.length === 0) {
      return Response.json(
        {
          success: false,
          error: 'merge_ids requires explicit update_ids in this version',
        },
        { status: 400 },
      );
    }

    const decisions = ensureDecisionIds(summary.decisions ?? []).flatMap(
      (decision, index) => {
        if (
          Array.from(deleteIds).some((id) =>
            matchesDecisionId(decision, index, id),
          )
        ) {
          return [];
        }

        const update = updates.find((item) =>
          matchesDecisionId(decision, index, item.id),
        );
        if (!update) {
          return [decision];
        }

        return [
          {
            ...decision,
            ...(update.description !== undefined && {
              description: update.description,
            }),
            ...(update.reason !== undefined && { reason: update.reason }),
            ...(update.alternatives !== undefined && {
              alternatives: update.alternatives,
            }),
          },
        ];
      },
    );

    const updated = await upsertTaskSummary({
      taskId: id,
      agentId: summary.agentId,
      sessionId: summary.sessionId ?? undefined,
      status: summary.status,
      progress: summary.progress ?? undefined,
      decisions,
      pending: removeItems(
        summary.pending ?? [],
        asStringArray(body.resolved_pending),
      ),
      knownIssues: removeItems(
        summary.knownIssues ?? [],
        asStringArray(body.resolved_issues),
      ),
    });

    return Response.json({
      success: true,
      data: { success: true, summary: updated },
    });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
