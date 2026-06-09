import { requireAuthAccess } from '@/lib/auth/access';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from '@/lib/knowledge';
import { cookies } from 'next/headers';

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id') ?? undefined;
    const includeDisabled =
      searchParams.get('include_disabled') === 'true' && access.isAdmin;

    const knowledgeBases = await listKnowledgeBases({
      agentId,
      includeDisabled,
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({
      success: true,
      data: knowledgeBases,
      meta: { isAdmin: access.isAdmin },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, error: message },
      { status: message === 'Unauthorized' ? 401 : 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return Response.json(
        { success: false, error: 'id is required' },
        { status: 400 },
      );
    }

    await deleteKnowledgeBase({
      knowledgeBaseId: id,
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

export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const body = await request.json();
    const id = String(body.id ?? '').trim();

    if (!id) {
      return Response.json(
        { success: false, error: 'id is required' },
        { status: 400 },
      );
    }

    const knowledgeBase = await updateKnowledgeBase({
      knowledgeBaseId: id,
      priority: body.priority,
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true, data: knowledgeBase });
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

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const body = await request.json();
    const name = String(body.name ?? '').trim();
    const requestedVisibility =
      body.visibility === 'team' || body.visibility === 'private'
        ? body.visibility
        : undefined;
    const visibility =
      requestedVisibility ?? (access.isAdmin ? 'team' : 'private');

    if (visibility === 'team' && !access.isAdmin) {
      return Response.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      );
    }

    if (!name) {
      return Response.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const knowledgeBase = await createKnowledgeBase({
      agentId: body.agent_id,
      visibility,
      ownerUserId:
        visibility === 'private'
          ? access.isAdmin && typeof body.owner_user_id === 'string'
            ? body.owner_user_id
            : access.session.userId
          : null,
      name,
      description: body.description,
      emoji: body.emoji,
      embeddingModel: body.embedding_model,
      chunkSize: body.chunk_size,
      chunkOverlap: body.chunk_overlap,
      priority: body.priority,
    });

    return Response.json(
      { success: true, data: knowledgeBase },
      { status: 201 },
    );
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
