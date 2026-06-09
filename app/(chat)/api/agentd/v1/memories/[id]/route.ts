import {
  deleteMemory,
  getResourceErrorMessage,
  getResourceErrorStatus,
} from '@/lib/core/db/agentd';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    await deleteMemory(id, {
      taskId: searchParams.get('task_id'),
      sessionId: searchParams.get('session_id'),
    });
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
