export const dynamic = 'force-dynamic';

import { writeReviewLogs } from '@/lib/core/db/agentd';

export async function POST(request: Request) {
  const body = await request.json();
  const logs = await writeReviewLogs(Array.isArray(body) ? body : [body]);
  return Response.json({ success: true, data: logs });
}
