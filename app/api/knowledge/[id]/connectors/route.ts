import { requireAuthAccess } from '@/lib/auth/access';
import {
  createKnowledgeConnector,
  deleteKnowledgeConnector,
  listKnowledgeConnectors,
} from '@/lib/knowledge';
import { cookies } from 'next/headers';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function errorStatus(message: string) {
  if (message === 'Unauthorized') return 401;
  if (message === 'Forbidden') return 403;
  if (message.includes('not found')) return 404;
  return 500;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id } = await params;
    const connectors = await listKnowledgeConnectors(id, {
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true, data: connectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, error: message },
      { status: errorStatus(message) },
    );
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id } = await params;
    const body = await request.json();
    const sourceUri = String(body.source_uri ?? '').trim();
    const name = String(body.name ?? '').trim();

    if (!sourceUri) {
      return Response.json(
        { success: false, error: 'source_uri is required' },
        { status: 400 },
      );
    }

    const result = await createKnowledgeConnector({
      knowledgeBaseId: id,
      name,
      sourceUri,
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
      { success: false, error: message },
      { status: errorStatus(message) },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const connectorId = searchParams.get('connector_id');

    if (!connectorId) {
      return Response.json(
        { success: false, error: 'connector_id is required' },
        { status: 400 },
      );
    }

    await deleteKnowledgeConnector({
      knowledgeBaseId: id,
      connectorId,
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
      { status: errorStatus(message) },
    );
  }
}
