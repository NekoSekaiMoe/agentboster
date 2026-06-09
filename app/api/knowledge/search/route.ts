import { searchKnowledge } from '@/lib/knowledge';
import { requireAuthAccess } from '@/lib/auth/access';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const body = await request.json();
    const query = String(body.query ?? '').trim();

    if (!query) {
      return Response.json(
        { success: false, error: 'query is required' },
        { status: 400 },
      );
    }

    const results = await searchKnowledge({
      query,
      agentId: body.agent_id,
      knowledgeBaseIds: body.knowledge_base_ids,
      knowledgeBaseNames: body.knowledge_base_names,
      limit: body.limit,
      minConfidence: body.min_confidence,
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
    });

    return Response.json({ success: true, data: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        success: false,
        error: message,
      },
      { status: message === 'Unauthorized' ? 401 : 500 },
    );
  }
}
