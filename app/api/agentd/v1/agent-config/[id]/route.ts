import { getAgentConfig } from '@/lib/core/db/agentd';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const config = await getAgentConfig(id);
  return Response.json({ success: true, data: config });
}
