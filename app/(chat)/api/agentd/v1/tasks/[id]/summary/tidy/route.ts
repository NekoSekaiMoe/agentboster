import { resolveLanguageModel } from '@/lib/ai';
import { getTaskSummary } from '@/lib/core/db/agentd';
import { getConfig } from '@/lib/core/kv/config';
import { generateText } from 'ai';

function decisionRef(
  decision: { id?: string } | null | undefined,
  index: number,
) {
  return decision?.id ?? `decision:${index}`;
}

function buildTidyPrompt(
  summary: NonNullable<Awaited<ReturnType<typeof getTaskSummary>>>,
) {
  const decisions = (summary.decisions ?? [])
    .map(
      (decision, index) =>
        `- id: ${decisionRef(decision, index)}\n  timestamp: ${decision.timestamp}\n  description: ${decision.description}\n  reason: ${decision.reason}\n  alternatives: ${(decision.alternatives ?? []).join('; ')}`,
    )
    .join('\n');

  return `You are a Task Summary Analyzer. Review this long-running task summary and suggest cleanup actions.

Current task summary:
- task_id: ${summary.taskId}
- status: ${summary.status}
- progress: ${summary.progress ?? ''}

Decisions:
${decisions || '(none)'}

Pending items:
${(summary.pending ?? []).map((item) => `- ${item}`).join('\n') || '(none)'}

Known issues:
${(summary.knownIssues ?? []).map((item) => `- ${item}`).join('\n') || '(none)'}

Rules:
- Identify duplicate or obsolete decisions by id.
- Flag pending items that appear completed based on progress.
- Flag known issues that appear resolved based on progress.
- Do not invent ids. Use only ids shown above.
- Do not delete anything unless it is clearly obsolete or duplicate.
- If no cleanup is needed, return empty arrays.

Return JSON only with this shape:
{
  "suggestions": ["<human-readable suggestion>"],
  "merge_ids": ["<decision id>"],
  "delete_ids": ["<decision id>"],
  "update_ids": [{"id":"<decision id>","description":"<optional>","reason":"<optional>","alternatives":["<optional>"]}],
  "resolved_pending": ["<exact pending item text>"],
  "resolved_issues": ["<exact known issue text>"]
}`;
}

function extractJsonObject(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('LLM response did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asUpdates(value: unknown) {
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

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const summary = await getTaskSummary(id);

  if (!summary) {
    return Response.json(
      { success: false, error: 'Task summary not found' },
      { status: 404 },
    );
  }

  const config = await getConfig();
  const modelId = config.models?.model;
  if (!modelId) {
    return Response.json(
      { success: false, error: 'Model is not configured' },
      { status: 500 },
    );
  }

  const result = await generateText({
    model: resolveLanguageModel(modelId, config),
    prompt: buildTidyPrompt(summary),
    temperature: 0,
    maxOutputTokens: 1024,
  });

  const parsed = extractJsonObject(result.text);

  return Response.json({
    success: true,
    data: {
      task_id: id,
      summary_last_updated: summary.lastUpdated.toISOString(),
      suggestions: asStringArray(parsed.suggestions),
      merge_ids: asStringArray(parsed.merge_ids),
      delete_ids: asStringArray(parsed.delete_ids),
      update_ids: asUpdates(parsed.update_ids),
      resolved_pending: asStringArray(parsed.resolved_pending),
      resolved_issues: asStringArray(parsed.resolved_issues),
    },
  });
}
