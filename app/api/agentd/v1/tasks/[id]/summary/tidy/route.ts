export const dynamic = 'force-dynamic';

import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  getTaskSummary,
  requireTaskAccess,
} from '@/lib/core/db/agentd';
import { generateTaskTidyReport } from '@/lib/extra/task-summary-tidy';

export async function POST(
  _request: Request,
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

    return Response.json({
      success: true,
      data: await generateTaskTidyReport(summary),
    });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
