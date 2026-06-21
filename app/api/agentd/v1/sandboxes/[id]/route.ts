export const dynamic = 'force-dynamic';

import { updateSandboxStatus } from '@/lib/core/db/agentd';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const sandbox = await updateSandboxStatus(id, body.status);
  return Response.json({ success: true, data: sandbox });
}
