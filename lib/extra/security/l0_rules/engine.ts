import { DEFAULT_L0_RULES } from './presets';
import type { IL0RuleEngine, L0Result, L0Rule } from './types';

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(
  input: string,
  pattern: string,
  patternType: 'regex' | 'glob',
): boolean {
  if (patternType === 'regex') {
    try {
      return new RegExp(pattern).test(input);
    } catch {
      return false;
    }
  }
  return globToRegex(pattern).test(input);
}

export class L0RuleEngine implements IL0RuleEngine {
  private rules: L0Rule[] = [];
  private temporaryOverrides = new Map<string, number>();

  constructor(rules?: L0Rule[]) {
    this.rules = rules ?? [...DEFAULT_L0_RULES];
  }

  async evaluate(command: string, _workingDirectory: string): Promise<L0Result> {
    const sortedRules = [...this.rules]
      .filter((r) => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (!matchesPattern(command, rule.pattern, rule.patternType)) {
        continue;
      }

      if (rule.action === 'allow') {
        return {
          matched: true,
          rule,
          action: 'allow',
          message: `Allowed by rule: ${rule.name}`,
        };
      }

      if (rule.action === 'block') {
        const overrideKey = `${rule.id}:${command}`;
        const overrideExpiry = this.temporaryOverrides.get(overrideKey);
        if (overrideExpiry && overrideExpiry > Date.now()) {
          return {
            matched: true,
            rule,
            action: 'allow',
            message: `Temporarily allowed by override: ${rule.name}`,
          };
        }

        return {
          matched: true,
          rule,
          action: 'block',
          message: `Blocked by rule: ${rule.name} - ${rule.description}`,
        };
      }

      if (rule.action === 'escalate') {
        return {
          matched: true,
          rule,
          action: 'escalate',
          message: `Escalated by rule: ${rule.name} - ${rule.description}`,
        };
      }
    }

    return {
      matched: false,
      rule: null,
      action: 'allow',
      message: 'No matching L0 rule, defaulting to allow',
    };
  }

  addRule(rule: L0Rule): void {
    const existingIndex = this.rules.findIndex((r) => r.id === rule.id);
    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  reloadRules(): void {
    this.rules = [...DEFAULT_L0_RULES];
  }

  addTemporaryOverride(
    ruleId: string,
    command: string,
    windowSeconds: number,
  ): void {
    const key = `${ruleId}:${command}`;
    this.temporaryOverrides.set(key, Date.now() + windowSeconds * 1000);
  }

  clearExpiredOverrides(): void {
    const now = Date.now();
    for (const [key, expiry] of this.temporaryOverrides) {
      if (expiry <= now) {
        this.temporaryOverrides.delete(key);
      }
    }
  }
}
