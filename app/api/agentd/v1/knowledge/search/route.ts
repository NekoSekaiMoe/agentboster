export const dynamic = 'force-dynamic';

import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import { searchKnowledge } from '@/lib/knowledge';

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

    const access = await resolveAgentdResourceAccess({
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
