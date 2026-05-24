import { deleteSession, getSession, updateSession } from '@/lib/core/db/chat';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return Response.json(
      { success: false, error: 'Session not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: session });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const session = await updateSession(id, body);
  if (!session) {
    return Response.json(
      { success: false, error: 'Session not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: session });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await deleteSession(id);
  if (!session) {
    return Response.json(
      { success: false, error: 'Session not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true });
}
