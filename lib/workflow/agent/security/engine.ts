import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import { DEFAULT_SECURITY_RULES } from './rules';
import type {
  SecurityCheckRequest,
  SecurityCheckResult,
  SecurityRule,
} from './types';

const logger = createLogger('workflow.agent.security');

function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

export class SecurityEngine {
  private rules: SecurityRule[] = [];

  constructor(rules: SecurityRule[] = DEFAULT_SECURITY_RULES) {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  addRule(rule: SecurityRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  check(
    request: SecurityCheckRequest,
    appConfig: AppConfig,
  ): SecurityCheckResult {
    const { toolName, input, context } = request;
    const autonomyLevel = appConfig.autonomy?.level ?? 'supervised';

    // In 'full' autonomy mode, only hard blocks apply (escalations are
    // suppressed). 'supervised' (the default) lets escalate rules surface
    // for review.
    const effectiveActionLimit =
      autonomyLevel === 'full' ? 'block' : 'escalate';

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!matchesToolPattern(rule.toolPattern, toolName)) continue;
      if (rule.paramCondition && !rule.paramCondition(input)) continue;

      if (rule.action === 'block') {
        logger.warn('security:block', {
          ruleId: rule.id,
          ruleName: rule.name,
          toolName,
          sessionId: context.sessionId,
        });
        return {
          decision: 'block',
          level: 'L0',
          ruleId: rule.id,
          reason: `Blocked by rule "${rule.name}" (${rule.id})`,
        };
      }

      if (rule.action === 'allow') {
        return {
          decision: 'allow',
          level: 'L0',
          ruleId: rule.id,
          reason: `Allowed by rule "${rule.name}" (${rule.id})`,
        };
      }

      if (rule.action === 'escalate' && effectiveActionLimit !== 'block') {
        logger.info('security:escalate', {
          ruleId: rule.id,
          ruleName: rule.name,
          toolName,
          sessionId: context.sessionId,
        });
        return {
          decision: 'escalate',
          level: 'L0',
          ruleId: rule.id,
          reason: `Escalated by rule "${rule.name}" (${rule.id})`,
        };
      }
    }

    return {
      decision: 'allow',
      level: 'L0',
      reason: 'No matching security rules',
    };
  }
}

let globalEngine: SecurityEngine | null = null;

export function getSecurityEngine(): SecurityEngine {
  if (!globalEngine) {
    globalEngine = new SecurityEngine();
  }
  return globalEngine;
}

export function setSecurityEngine(engine: SecurityEngine): void {
  globalEngine = engine;
}
