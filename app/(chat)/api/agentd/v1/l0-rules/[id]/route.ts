import { getL0Rules } from '@/lib/core/db/agentd';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rules = await getL0Rules(id);
  return Response.json({ success: true, data: rules });
}
