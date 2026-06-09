import { requireAuthAccess } from '@/lib/auth/access';
import { syncKnowledgeConnector } from '@/lib/knowledge';
import { cookies } from 'next/headers';

type RouteContext = {
  params: Promise<{ id: string; connectorId: string }>;
};

function errorStatus(message: string) {
  if (message === 'Unauthorized') return 401;
  if (message === 'Forbidden') return 403;
  if (message.includes('not found')) return 404;
  return 500;
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { id, connectorId } = await params;
    const result = await syncKnowledgeConnector({
      knowledgeBaseId: id,
      connectorId,
      access: {
        userId: access.session.userId,
        isAdmin: access.isAdmin,
      },
      includeAllPrivate: access.isAdmin,
    });

    return Response.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, error: message },
      { status: errorStatus(message) },
    );
  }
}
