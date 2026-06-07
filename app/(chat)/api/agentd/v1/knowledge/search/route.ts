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

    const results = await searchKnowledge({
      query,
      agentId: body.agent_id,
      knowledgeBaseIds: body.knowledge_base_ids,
      knowledgeBaseNames: body.knowledge_base_names,
      limit: body.limit,
      minConfidence: body.min_confidence,
    });

    return Response.json({ success: true, data: results });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
