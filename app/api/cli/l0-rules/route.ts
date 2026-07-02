/**
 * GET /api/cli/l0-rules
 *
 * Returns the L0 command rules the CLI should enforce locally before
 * running a shell command. Mirrors the data the Web UI edits via
 * /api/config/l0-rules and that agentd pulls via /api/agentd/v1/l0-rules/:id.
 *
 * The CLI is a thin client: it does not own the rule table, it just
 * downloads the user's current global-scope rules at session start
 * (and periodically refreshes) and evaluates them client-side so L0
 * enforcement works without a network round-trip per command.
 *
 * Scope: global only. agent-scoped rules require mapping a CLI session
 * to an agent id, which is not wired through yet.
 */

import { withCliAuth } from '@/lib/cli/auth';
import { listL0Rules } from '@/lib/core/db/agentd';

export const GET = withCliAuth(async () => {
  const all = await listL0Rules();
  // Filter to enabled global command rules — those are the only ones
  // the CLI's evaluateLocalCommand can apply (path/network types and
  // agent-scoped rules need host context the CLI doesn't have).
  const rules = all
    .filter((r) => r.enabled && r.agentId === 'global' && r.type === 'command')
    .map((r) => ({
      pattern: r.pattern,
      action: r.action, // 'block' | 'warn'
    }));

  return Response.json({ ok: true, rules });
});
