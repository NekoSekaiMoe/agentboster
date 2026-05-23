import { deleteMemory } from '@/lib/core/db/agentd';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await deleteMemory(id);
  return Response.json({ success: true });
}
