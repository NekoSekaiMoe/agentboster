/**
 * Commands and lifecycle hooks example extension.
 *
 * Demonstrates:
 *   1. `pi.registerCommand` — slash commands with the standard
 *      `/<base>` (run), `/<base> config` (configure), and `/<base>
 *      config <args>` (set) contracts.
 *   2. `pi.on('session_start')` — seed per-session state.
 *   3. `pi.on('before_provider_request')` — observe / mutate the
 *      outgoing provider request (e.g. inject extra headers, log).
 *   4. `pi.on('message_end')` — react after each assistant message.
 *   5. `pi.on('agent_end')` — turn-level cleanup.
 *
 * The example tracks how many turns a session has had and exposes it
 * via the `/turncount` command. Useful for usage dashboards, A/B
 * logging, etc.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@agentboster/sdk';

// Per-session counters keyed by session id. Cleared on session_shutdown.
const sessionTurnCounts = new Map<string, number>();

export default function turnCounter(pi: ExtensionAPI): void {
  // ── Lifecycle: seed on session start ──────────────────────────────
  pi.on('session_start', (event) => {
    const sid = (event as { sessionId?: string }).sessionId ?? 'default';
    if (!sessionTurnCounts.has(sid)) {
      sessionTurnCounts.set(sid, 0);
    }
  });

  pi.on('session_shutdown', () => {
    // Optional: persist the counts to disk, send to analytics, etc.
    // Here we just clear.
    sessionTurnCounts.clear();
  });

  // ── Observe each outgoing provider request ────────────────────────
  // Use this for telemetry, header injection (custom proxy auth,
  // feature flags), or request rewriting. Return nothing to let the
  // request pass through unchanged; return an object to override.
  pi.on('before_provider_request', (event) => {
    // Example: log model + token estimate. Real extensions might also
    // mutate headers here.
    const e = event as { model?: string; messages?: unknown[] };
    console.debug('[turn-counter] provider request', {
      model: e.model,
      messageCount: Array.isArray(e.messages) ? e.messages.length : 0,
    });
  });

  // ── Count a turn after each assistant message finishes ────────────
  pi.on('message_end', (_event, ctx) => {
    if (!ctx?.sessionId) return;
    sessionTurnCounts.set(
      ctx.sessionId,
      (sessionTurnCounts.get(ctx.sessionId) ?? 0) + 1,
    );
  });

  // ── Reset on agent_end so a multi-message turn still counts as 1 ──
  // (Depends on what you mean by "turn" — adjust to taste.)
  pi.on('agent_end', () => {
    // no-op; counting happens at message_end granularity.
  });

  // ── Slash command: /turncount ─────────────────────────────────────
  // Following the standard contract:
  //   /turncount           — print the current session's turn count
  //   /turncount reset     — reset to 0
  //   /turncount config    — show configuration help (no real config)
  pi.registerCommand('turncount', {
    description:
      'Show how many assistant messages this session has produced. ' +
      'Subcommand: "reset" zeros the counter.',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const sid = ctx.sessionId ?? 'default';
      const subcommand = (args[0] ?? '').toLowerCase();

      if (subcommand === 'reset') {
        sessionTurnCounts.set(sid, 0);
        ctx.ui.notify('Turn counter reset to 0', 'info');
        return;
      }

      const count = sessionTurnCounts.get(sid) ?? 0;
      ctx.ui.notify(
        count === 0
          ? 'No turns yet in this session.'
          : `${count} assistant message(s) in this session.`,
        'info',
      );
    },
  });
}
