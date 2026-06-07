import { createKnowledgeBase, listKnowledgeBases } from '@/lib/knowledge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id') ?? undefined;
  const includeDisabled = searchParams.get('include_disabled') === 'true';

  const knowledgeBases = await listKnowledgeBases({
    agentId,
    includeDisabled,
  });

  return Response.json({ success: true, data: knowledgeBases });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = String(body.name ?? '').trim();

    if (!name) {
      return Response.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const knowledgeBase = await createKnowledgeBase({
      agentId: body.agent_id,
      name,
      description: body.description,
      emoji: body.emoji,
      embeddingModel: body.embedding_model,
      chunkSize: body.chunk_size,
      chunkOverlap: body.chunk_overlap,
    });

    return Response.json(
      { success: true, data: knowledgeBase },
      { status: 201 },
    );
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
