import { extractTaskMemory } from '@/lib/extra/task-memory';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks.memory');

function taskStatus(value: unknown) {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : 'completed';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await extractTaskMemory({
    taskId: id,
    agentId: typeof body.agent_id === 'string' ? body.agent_id : 'default',
    sessionId:
      typeof body.session_id === 'string' ? body.session_id : undefined,
    command: typeof body.command === 'string' ? body.command : '',
    result: typeof body.result === 'string' ? body.result : '',
    status: taskStatus(body.status),
  });

  logger.info('task memory processed', { taskId: id, mode: result.mode });
  return Response.json({ success: true, data: result });
}
