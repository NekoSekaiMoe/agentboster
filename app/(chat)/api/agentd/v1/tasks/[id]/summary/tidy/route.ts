import { getTaskSummary } from '@/lib/core/db/agentd';
import { generateTaskTidyReport } from '@/lib/extra/task-summary-tidy';

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

  return Response.json({
    success: true,
    data: await generateTaskTidyReport(summary),
  });
}
