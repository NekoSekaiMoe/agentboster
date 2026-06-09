import {
  getMemories,
  getResourceErrorMessage,
  getResourceErrorStatus,
  writeMemories,
} from '@/lib/core/db/agentd';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id') ?? 'default';
    const keywords =
      searchParams
        .get('keywords')
        ?.split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean) ?? [];
    const limit = Number(searchParams.get('limit') ?? 10);
    const memories = await getMemories(agentId, keywords, limit, {
      taskId: searchParams.get('task_id'),
      sessionId: searchParams.get('session_id'),
    });
    return Response.json({ success: true, data: memories });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const memoryInput = Array.isArray(body) ? body : body.memories;
    if (!Array.isArray(memoryInput)) {
      return Response.json(
        { success: false, error: 'memories must be an array' },
        { status: 400 },
      );
    }
    const memories = await writeMemories(memoryInput, {
      taskId: body.task_id,
      sessionId: body.session_id,
    });
    return Response.json({ success: true, data: memories });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
