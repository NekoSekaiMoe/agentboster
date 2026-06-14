import {
  deriveSessionIdentity,
  getResourceErrorMessage,
  getResourceErrorStatus,
  requireTaskAccess,
} from '@/lib/core/db/agentd';
import { hasAdminRole } from '@/lib/core/db/users';
import { searchKnowledge } from '@/lib/knowledge';

async function resolveAgentdKnowledgeAccess(input: {
  taskId?: string | null;
  sessionId?: string | null;
}) {
  if (input.taskId) {
    const task = await requireTaskAccess({
      taskId: input.taskId,
      sessionId: input.sessionId,
    });
    if (!task.userId) {
      throw Object.assign(new Error('Task owner is unknown'), { status: 403 });
    }
    return {
      userId: task.userId,
      isAdmin: hasAdminRole(task.roles),
    };
  }

  if (!input.sessionId) {
    throw Object.assign(new Error('task_id or session_id is required'), {
      status: 400,
    });
  }

  const identity = await deriveSessionIdentity(input.sessionId);
  if (!identity.userId) {
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }

  return {
    userId: identity.userId,
    isAdmin: hasAdminRole(identity.roles),
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = String(body.query ?? '').trim();

    if (!query) {
      return Response.json(
        { success: false, error: 'query is required' },
        { status: 400 },
      );
    }

    const access = await resolveAgentdKnowledgeAccess({
      taskId: typeof body.task_id === 'string' ? body.task_id : undefined,
      sessionId:
        typeof body.session_id === 'string' ? body.session_id : undefined,
    });

    const results = await searchKnowledge({
      query,
      agentId: body.agent_id,
      knowledgeBaseIds: body.knowledge_base_ids,
      knowledgeBaseNames: body.knowledge_base_names,
      limit: body.limit,
      minConfidence: body.min_confidence,
      access,
    });

    return Response.json({ success: true, data: results });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: getResourceErrorMessage(error),
      },
      { status: getResourceErrorStatus(error) },
    );
  }
}
