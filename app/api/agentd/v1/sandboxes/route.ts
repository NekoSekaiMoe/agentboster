import { registerSandbox } from '@/lib/core/db/agentd';

export async function POST(request: Request) {
  const body = await request.json();
  const sandbox = await registerSandbox({
    agentId: body.agent_id,
    type: body.type,
    path: body.path,
    persistent: body.persistent,
  });
  return Response.json({ success: true, data: sandbox }, { status: 201 });
}
