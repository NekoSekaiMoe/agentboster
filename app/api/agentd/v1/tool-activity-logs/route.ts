export const dynamic = 'force-dynamic';

import { createTraceCallbackHandler } from '../trace-callbacks';

export const POST = createTraceCallbackHandler({
  allowed: 'tool',
  scope: 'api.agentd.tool-activity-logs',
  failureMessage: 'Failed to write tool activity logs',
});
