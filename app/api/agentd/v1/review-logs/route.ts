export const dynamic = 'force-dynamic';

import { createTraceCallbackHandler } from '../trace-callbacks';

export const POST = createTraceCallbackHandler({
  allowed: 'review',
  scope: 'api.agentd.review-logs',
  failureMessage: 'Failed to write review logs',
});
