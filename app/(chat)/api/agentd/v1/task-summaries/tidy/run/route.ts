import { listActiveTaskSummaries } from '@/lib/core/db/agentd';
import { createNotification } from '@/lib/core/db/notification';
import { generateTaskTidyReport } from '@/lib/extra/task-summary-tidy';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.task-summaries.tidy.run');

function numberValue(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const agentId = typeof body.agent_id === 'string' ? body.agent_id : 'default';
  const limit = Math.max(1, Math.min(numberValue(body.limit, 50), 200));
  const summaries = (await listActiveTaskSummaries(agentId)).slice(0, limit);
  const reports = [];
  const errors = [];

  for (const summary of summaries) {
    try {
      const report = await generateTaskTidyReport(summary);
      if (report.suggestions.length > 0) {
        reports.push(report);
        await createNotification({
          taskId: summary.taskId,
          notificationType: 'tidy_report',
          payload: {
            type: 'tidy_report',
            taskId: summary.taskId,
            title: 'Task Summary Tidy Report',
            summary:
              'Your task summary has been reviewed. Here are suggestions for cleanup.',
            summaryLastUpdated: report.summary_last_updated,
            suggestions: report.suggestions,
            mergeIds: report.merge_ids,
            deleteIds: report.delete_ids,
            updateIds: report.update_ids,
            resolvedPending: report.resolved_pending,
            resolvedIssues: report.resolved_issues,
          },
          channel: 'telegram',
          targetChatId: 'default',
        });
      }
    } catch (error) {
      logger.warn('tidy report generation failed', {
        taskId: summary.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      errors.push({
        task_id: summary.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({
    success: true,
    data: {
      scanned: summaries.length,
      reports,
      errors,
    },
  });
}
