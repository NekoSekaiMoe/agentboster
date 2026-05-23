import { getMemories, writeMemories } from '@/lib/core/db/agentd';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id') ?? 'default';
  const keywords = searchParams.get('keywords')?.split(',') ?? [];
  const limit = Number(searchParams.get('limit') ?? 10);
  const memories = await getMemories(agentId, keywords, limit);
  return Response.json({ success: true, data: memories });
}

export async function POST(request: Request) {
  const body = await request.json();
  const memories = await writeMemories(body);
  return Response.json({ success: true, data: memories });
}
