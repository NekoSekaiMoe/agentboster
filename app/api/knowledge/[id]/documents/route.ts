import { requireAuthAccess } from '@/lib/auth/access';
import {
  addKnowledgeDocument,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
} from '@/lib/knowledge';
import { cookies } from 'next/headers';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id } = await params;
    const documents = await listKnowledgeDocuments(id, {
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true, data: documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, error: message },
      {
        status:
          message === 'Unauthorized'
            ? 401
            : message.includes('not found')
              ? 404
              : 500,
      },
    );
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
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
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        success: false,
        error: message,
      },
      {
        status:
          message === 'Unauthorized'
            ? 401
            : message === 'Forbidden'
              ? 403
              : message.includes('not found')
                ? 404
                : 500,
      },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get('document_id');

    if (!documentId) {
      return Response.json(
        { success: false, error: 'document_id is required' },
        { status: 400 },
      );
    }

    await deleteKnowledgeDocument({
      knowledgeBaseId: id,
      documentId,
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, error: message },
      {
        status:
          message === 'Unauthorized'
            ? 401
            : message === 'Forbidden'
              ? 403
              : message.includes('not found')
                ? 404
                : 500,
      },
    );
  }
}
