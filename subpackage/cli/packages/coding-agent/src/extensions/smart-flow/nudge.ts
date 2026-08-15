/**
 * smart-flow — Delegation nudge
 *
 * Appends a compact delegation guidance block to the system prompt on
 * `before_agent_start`, but only when the `subagent` tool (pi-subagents)
 * is actually active — otherwise the guidance would point at a tool the
 * model cannot call.
 *
 * Adapted from pi-maestro-flow's nudge (MIT, Copyright (c) 2026 catlog22)
 * and pi-smart-flow's rewrite for pi-subagents, adjusted for the
 * agentboster fork: subagents spawn agentboster-cli subprocesses whose
 * LLM traffic also routes through the Web backend.
 */

import type { ExtensionAPI } from '../../core/extensions/index.ts';

/**
 * The injected guidance. Keep this short, stable, and cache-friendly:
 * it is appended verbatim on every agent start, so any change invalidates
 * the prompt cache prefix for the whole session.
 */
const DELEGATION_GUIDANCE = `<delegation_guidance>
You have a subagent tool. Delegate aggressively to keep this main context clean.

Delegate when:
- Exploration or search spans multiple files/modules, or you need to read bulk output (logs, large files, test runs) whose raw content would flood this context.
- A workstream is independent: research, code review, debugging a self-contained failure, or implementing an approved, well-scoped change.
- You would otherwise read more than ~2 files just to answer "where/what" before acting.

Work inline when:
- Reading a known file, looking up a single symbol, or making a bounded one-to-two-file edit.

How to delegate well:
- Prefer async: true. Launch the subagent, continue your own local work, and collect results when they are needed instead of blocking.
- Pick the role that fits: scout for codebase recon, researcher for web evidence, reviewer for adversarial review, worker for implementation, planner for plans, oracle for direction checks.
- Write the task as a compact contract: GOAL, CONTEXT (files/decisions/constraints), EXPECTED OUTPUT (shape and where), STOP RULES (when to report back or ask).
- Use outputMode: "file-only" for large reports; read the saved file selectively instead of absorbing the whole output.
- Keep one writer: never edit files an async worker is changing; run parallel writers only in isolated worktrees.
- After three failed attempts at the same problem, stop — delegate a fresh investigation or ask the user for direction.
</delegation_guidance>`;

/**
 * Set AGENTBOSTER_SMART_FLOW_NUDGE=0 (or the upstream PI_SMART_FLOW_NUDGE=0)
 * to disable the nudge.
 */
function nudgeEnabled(): boolean {
  return (
    process.env.AGENTBOSTER_SMART_FLOW_NUDGE !== '0' &&
    process.env.PI_SMART_FLOW_NUDGE !== '0'
  );
}

export function registerDelegationNudge(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event) => {
    if (!nudgeEnabled()) return;
    if (!pi.getActiveTools().includes('subagent')) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_GUIDANCE}`,
    };
  });
}
