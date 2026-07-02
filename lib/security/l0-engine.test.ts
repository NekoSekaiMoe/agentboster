/**
 * Tests for the Web-side L0 engine (Vercel Sandbox fallback gate).
 *
 * DB layer is mocked so the tests run without a live Postgres. Focus
 * is on the gate *policy*: block vs warn vs allow, regex errors,
 * fail-open on DB error, agent/global precedence.
 *
 * Run via: yarn test lib/security/l0-engine.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateL0 } from './l0-engine';
import type { L0Rule } from './l0-engine';

let nextRules: L0Rule[] = [];

vi.mock('@/lib/core/db/agentd', () => ({
  // evaluateL0 calls getL0Rules(agentId); we ignore agentId and return
  // whatever the test staged.
  getL0Rules: vi.fn(async () => nextRules),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

function rule(overrides: Partial<L0Rule> = {}): L0Rule {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'global',
    pattern: '.*',
    type: 'command',
    action: 'block',
    scope: 'global',
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  nextRules = [];
});

describe('evaluateL0 — allow path', () => {
  it('allows when no rules', async () => {
    const result = await evaluateL0('global', 'ls -la');
    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('');
  });

  it('allows when no enabled command rule matches', async () => {
    nextRules = [
      rule({ pattern: '^rm\\s+-rf', enabled: true }),
      rule({ type: 'path', pattern: '/etc/shadow', enabled: true }),
      rule({ type: 'network', pattern: 'evil\\.com', enabled: true }),
    ];
    const result = await evaluateL0('global', 'git status');
    expect(result.blocked).toBe(false);
  });

  it('allows when matching rule is disabled', async () => {
    nextRules = [rule({ pattern: '^rm', enabled: false })];
    const result = await evaluateL0('global', 'rm -rf /');
    expect(result.blocked).toBe(false);
  });

  it('allows empty / whitespace commands without DB hit', async () => {
    const { getL0Rules } = await import('@/lib/core/db/agentd');
    vi.mocked(getL0Rules).mockClear();
    expect((await evaluateL0('global', '')).blocked).toBe(false);
    expect((await evaluateL0('global', '   ')).blocked).toBe(false);
    expect(getL0Rules).not.toHaveBeenCalled();
  });
});

describe('evaluateL0 — block path', () => {
  it('blocks when an enabled block rule matches', async () => {
    nextRules = [rule({ pattern: 'rm\\s+-rf\\s+/', action: 'block' })];
    const result = await evaluateL0('global', 'rm -rf /');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('rm\\s+-rf\\s+/');
    expect(result.matchedRule?.id).toBe(nextRules[0].id);
  });

  it('blocks when any one of several rules matches', async () => {
    nextRules = [
      rule({ pattern: '^mkfs' }),
      rule({ pattern: 'dd\\s+.*of=/dev/' }),
    ];
    const result = await evaluateL0('global', 'dd if=/dev/zero of=/dev/sda');
    expect(result.blocked).toBe(true);
  });
});

describe('evaluateL0 — warn path', () => {
  it('does NOT block on a warn rule, even when it matches', async () => {
    nextRules = [rule({ pattern: 'curl\\s+', action: 'warn' })];
    const result = await evaluateL0('global', 'curl https://example.com');
    expect(result.blocked).toBe(false);
  });

  it('still blocks when a warn rule precedes a matching block rule', async () => {
    nextRules = [
      rule({ pattern: 'curl\\s+', action: 'warn' }),
      rule({ pattern: 'evil\\.com', action: 'block' }),
    ];
    const result = await evaluateL0('global', 'curl https://evil.com');
    expect(result.blocked).toBe(true);
  });
});

describe('evaluateL0 — robustness', () => {
  it('skips rules with invalid regex without crashing', async () => {
    nextRules = [
      rule({ id: 'bad', pattern: '[invalid', action: 'block' }),
      rule({ id: 'good', pattern: '^rm', action: 'block' }),
    ];
    const result = await evaluateL0('global', 'rm -rf x');
    expect(result.blocked).toBe(true);
    expect(result.matchedRule?.id).toBe('good');
  });

  it('fails open (allows) when DB throws', async () => {
    const { getL0Rules } = await import('@/lib/core/db/agentd');
    vi.mocked(getL0Rules).mockRejectedValueOnce(new Error('DB down'));
    const result = await evaluateL0('global', 'rm -rf /');
    expect(result.blocked).toBe(false);
  });
});

describe('evaluateL0 — scope precedence', () => {
  it('agent-scoped rule is evaluated before global', async () => {
    // Both match the same command; the agent-scoped one comes first in
    // the sorted list. Since the test's sort is stable and agent-scoped
    // sorts before global, the agent-scoped block rule wins (earlier
    // match short-circuits). This documents the intended precedence.
    nextRules = [
      rule({ agentId: 'global', pattern: 'rm\\s+-rf', action: 'block' }),
      rule({ agentId: 'agent-7', pattern: 'rm\\s+-rf', action: 'block' }),
    ];
    const result = await evaluateL0('agent-7', 'rm -rf x');
    expect(result.blocked).toBe(true);
  });

  it('non-command rule types are ignored even if enabled', async () => {
    nextRules = [
      rule({ type: 'path', pattern: '.*', action: 'block' }),
      rule({ type: 'network', pattern: '.*', action: 'block' }),
    ];
    const result = await evaluateL0('global', 'anything');
    expect(result.blocked).toBe(false);
  });
});
