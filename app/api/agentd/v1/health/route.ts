export const dynamic = 'force-dynamic';

import { getAgentdHealth } from '@/lib/extra/agent/agentd-tools-client';

export async function GET() {
  const daemon = await getAgentdHealth();

  return Response.json({
    success: true,
    data: {
      status: 'ok',
      service: 'agentd-api',
      daemon: daemon
        ? {
            ...daemon,
            status: 'online',
          }
        : {
            status: 'offline',
          },
      timestamp: new Date().toISOString(),
    },
  });
}
