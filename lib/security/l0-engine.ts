/**
 * Web-side L0 rule engine (Vercel Sandbox fallback gate).
 *
 * agentd has its own L0 implementation in Go (internal/security/l0_rules)
 * which runs when commands execute on an agentd node. This module is
 * the Web-side equivalent for the Vercel Sandbox fallback path: when
 * no agentd is available and the Web agent falls back to executing on
 * Vercel Sandbox, L0 block/warn rules would otherwise be silently
 * bypassed. This module closes that gap.
 *
 * Scope: command rules only (matching the shell command string). Path
 * and network rule types are stored for audit/future use, same as the
 * agentd side. Block rules short-circuit the exec; warn rules return
 * a warning the caller can surface to the LLM without blocking.
 *
 * Rule precedence: agent-scoped rules take priority over global
 * (agentId='global'), mirroring agentd's resolution.
 */

import { getL0Rules } from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('security.l0-engine');

export interface L0Rule {
  id: string;
  agentId: string;
  pattern: string;
  type: 'command' | 'path' | 'network';
  action: 'block' | 'warn';
  scope: 'workspace' | 'global';
  enabled: boolean;
}

export interface L0Evaluation {
  /** Whether the command should be blocked. */
  blocked: boolean;
  /** Human-readable reason for the decision (empty when allowed). */
  reason: string;
  /** The matched rule, if any (for audit logging). */
  matchedRule?: L0Rule;
}

const ALLOWED: L0Evaluation = { blocked: false, reason: '' };

/**
 * Evaluate a shell command against L0 rules for the given agent.
 *
 * Returns { blocked: true, ... } if any enabled command-type rule with
 * action='block' matches; the caller must refuse to execute. Warn
 * rules produce { blocked: false } but with a reason the caller can
 * surface to the LLM as a non-blocking heads-up.
 *
 * DB errors degrade to allow (fail-open): the Vercel Sandbox fallback
 * path is already a degraded mode, and a DB outage shouldn't make it
 * *worse* by blocking all commands. The failure is logged.
 *
 * @param agentId the agent whose rules to apply (plus global rules)
 * @param command the shell command about to run
 */
export async function evaluateL0(
  agentId: string,
  command: string,
): Promise<L0Evaluation> {
  if (!command.trim()) return ALLOWED;

  let rules: L0Rule[];
  try {
    const rows = await getL0Rules(agentId);
    rules = rows as unknown as L0Rule[];
  } catch (err) {
    logger.error('l0 rule lookup failed, failing open', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return ALLOWED;
  }

  // Sort: agent-scoped first (more specific), then global. Within the
  // same scope, last-created wins (array order from DB).
  const scoped = rules
    .filter((r) => r.enabled && r.type === 'command')
    .sort((a, b) => {
      const aGlobal = a.agentId === 'global' ? 1 : 0;
      const bGlobal = b.agentId === 'global' ? 1 : 0;
      return aGlobal - bGlobal;
    });

  for (const rule of scoped) {
    let matched = false;
    try {
      matched = new RegExp(rule.pattern).test(command);
    } catch {
      // Invalid regex in a user-defined rule — skip it. Don't break
      // the whole gate because one pattern is malformed.
      logger.warn('l0 rule has invalid regex, skipping', {
        ruleId: rule.id,
        pattern: rule.pattern,
      });
      continue;
    }

    if (!matched) continue;

    if (rule.action === 'block') {
      logger.info('l0 rule blocked command', {
        agentId,
        ruleId: rule.id,
        pattern: rule.pattern,
        commandPreview: command.slice(0, 120),
      });
      return {
        blocked: true,
        reason: `Blocked by L0 rule "${rule.pattern}" (action: block)`,
        matchedRule: rule,
      };
    }

    // action === 'warn' — don't block, but record and continue checking
    // in case a later block rule also matches.
    logger.info('l0 rule warned on command', {
      agentId,
      ruleId: rule.id,
      pattern: rule.pattern,
      commandPreview: command.slice(0, 120),
    });
  }

  return ALLOWED;
}
