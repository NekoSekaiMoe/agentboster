export const dynamic = 'force-dynamic';

import { listActiveTaskSummaries } from '@/lib/core/db/agentd';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id') ?? 'default';
  const summaries = await listActiveTaskSummaries(agentId);
  return Response.json({ success: true, data: summaries });
}
