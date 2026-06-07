import { addKnowledgeDocument, listKnowledgeDocuments } from '@/lib/knowledge';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const documents = await listKnowledgeDocuments(id);

  return Response.json({ success: true, data: documents });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await request.json();
    const title = String(body.title ?? '').trim();
    const content = String(body.content ?? '').trim();

    if (!title) {
      return Response.json(
        { success: false, error: 'title is required' },
        { status: 400 },
      );
    }

    if (!content) {
      return Response.json(
        { success: false, error: 'content is required' },
        { status: 400 },
      );
    }

    const result = await addKnowledgeDocument({
      knowledgeBaseId: id,
      title,
      content,
      sourceType: body.source_type,
      sourceUri: body.source_uri,
      metadata: body.metadata,
    });

    return Response.json({ success: true, data: result }, { status: 201 });
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
