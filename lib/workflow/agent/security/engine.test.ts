/**
 * Tests for the security rule engine and its built-in rule set.
 *
 * lib/workflow/agent/security/engine.ts is the L0 gate that decides
 * allow/block/escalate for every sandbox tool call, ordered by rule
 * priority. The engine is pure (no DB) — it takes a request + AppConfig
 * and returns a decision. This file covers the engine mechanics
 * (priority ordering, tool-pattern matching, autonomy suppression,
 * rule add/remove) and the built-in DEFAULT_SECURITY_RULES detectors.
 */

import { describe, expect, it } from 'vitest';
import { SecurityEngine, getSecurityEngine, setSecurityEngine } from './engine';
import { DEFAULT_SECURITY_RULES } from './rules';
import type { SecurityCheckRequest, SecurityRule } from './types';
import type { AppConfig } from '@/types/config';

function makeRequest(
  toolName: string,
  input: Record<string, unknown>,
): SecurityCheckRequest {
  return {
    toolName,
    toolId: 'tool-1',
    input,
    context: {
      sessionId: 's1',
      runId: 'r1',
      agentName: 'main',
      autonomyLevel: 'supervised',
      appConfig: supervisedConfig(),
    },
  };
}

function supervisedConfig(): AppConfig {
  return { autonomy: { level: 'supervised' } } as AppConfig;
}

function fullAutonomyConfig(): AppConfig {
  return { autonomy: { level: 'full' } } as AppConfig;
}

// ── engine mechanics ────────────────────────────────────────────────

describe('SecurityEngine — tool pattern matching', () => {
  it('matches the wildcard "*" against any tool', () => {
    const engine = new SecurityEngine([
      {
        id: 'wild',
        name: 'wild',
        toolPattern: '*',
        action: 'block',
        priority: 1,
        enabled: true,
      },
    ]);
    expect(
      engine.check(makeRequest('anything.x', {}), supervisedConfig()).decision,
    ).toBe('block');
  });

  it('matches an exact tool name', () => {
    const engine = new SecurityEngine([
      {
        id: 'exact',
        name: 'exact',
        toolPattern: 'sandbox.exec',
        action: 'block',
        priority: 1,
        enabled: true,
      },
    ]);
    expect(
      engine.check(makeRequest('sandbox.exec', {}), supervisedConfig())
        .decision,
    ).toBe('block');
    expect(
      engine.check(makeRequest('sandbox.read', {}), supervisedConfig())
        .decision,
    ).toBe('allow');
  });

  it('matches a "prefix.*" wildcard', () => {
    const engine = new SecurityEngine([
      {
        id: 'pfx',
        name: 'pfx',
        toolPattern: 'sandbox.*',
        action: 'block',
        priority: 1,
        enabled: true,
      },
    ]);
    expect(
      engine.check(makeRequest('sandbox.exec', {}), supervisedConfig())
        .decision,
    ).toBe('block');
    expect(
      engine.check(makeRequest('other.exec', {}), supervisedConfig()).decision,
    ).toBe('allow');
  });

  it('does NOT match when pattern is a bare prefix without .*', () => {
    // "sandbox." (no star) is treated as a literal exact name — it must
    // not match "sandbox.exec".
    const engine = new SecurityEngine([
      {
        id: 'lit',
        name: 'lit',
        toolPattern: 'sandbox.',
        action: 'block',
        priority: 1,
        enabled: true,
      },
    ]);
    expect(
      engine.check(makeRequest('sandbox.exec', {}), supervisedConfig())
        .decision,
    ).toBe('allow');
  });
});

describe('SecurityEngine — priority ordering', () => {
  it('evaluates higher priority first (descending)', () => {
    const engine = new SecurityEngine([
      {
        id: 'low',
        name: 'low',
        toolPattern: '*',
        action: 'allow',
        priority: 1,
        enabled: true,
      },
      {
        id: 'high',
        name: 'high',
        toolPattern: '*',
        action: 'block',
        priority: 100,
        enabled: true,
      },
    ]);
    // Both match, but priority 100 (block) wins.
    expect(engine.check(makeRequest('x', {}), supervisedConfig()).ruleId).toBe(
      'high',
    );
  });

  it('first matching rule wins among same-priority (stable sort)', () => {
    const engine = new SecurityEngine([
      {
        id: 'first',
        name: 'first',
        toolPattern: '*',
        action: 'block',
        priority: 50,
        enabled: true,
      },
      {
        id: 'second',
        name: 'second',
        toolPattern: '*',
        action: 'allow',
        priority: 50,
        enabled: true,
      },
    ]);
    expect(engine.check(makeRequest('x', {}), supervisedConfig()).ruleId).toBe(
      'first',
    );
  });
});

describe('SecurityEngine — enabled / paramCondition gating', () => {
  it('skips disabled rules', () => {
    const engine = new SecurityEngine([
      {
        id: 'off',
        name: 'off',
        toolPattern: '*',
        action: 'block',
        priority: 100,
        enabled: false,
      },
    ]);
    expect(
      engine.check(makeRequest('x', {}), supervisedConfig()).decision,
    ).toBe('allow');
  });

  it('skips a rule whose paramCondition returns false', () => {
    const engine = new SecurityEngine([
      {
        id: 'cond',
        name: 'cond',
        toolPattern: '*',
        paramCondition: (input) => Boolean(input.danger),
        action: 'block',
        priority: 100,
        enabled: true,
      },
    ]);
    expect(
      engine.check(makeRequest('x', { danger: false }), supervisedConfig())
        .decision,
    ).toBe('allow');
    expect(
      engine.check(makeRequest('x', { danger: true }), supervisedConfig())
        .decision,
    ).toBe('block');
  });
});

describe('SecurityEngine — autonomy level suppression', () => {
  const escalateRule: SecurityRule = {
    id: 'esc',
    name: 'esc',
    toolPattern: '*',
    action: 'escalate',
    priority: 100,
    enabled: true,
  };
  const blockRule: SecurityRule = {
    id: 'blk',
    name: 'blk',
    toolPattern: '*',
    action: 'block',
    priority: 50,
    enabled: true,
  };

  it('surfaces escalate rules under supervised (default) autonomy', () => {
    const engine = new SecurityEngine([escalateRule]);
    expect(
      engine.check(makeRequest('x', {}), supervisedConfig()).decision,
    ).toBe('escalate');
  });

  it('suppresses escalate rules under full autonomy (acts as if allow)', () => {
    const engine = new SecurityEngine([escalateRule]);
    expect(
      engine.check(makeRequest('x', {}), fullAutonomyConfig()).decision,
    ).toBe('allow');
  });

  it('still blocks under full autonomy', () => {
    const engine = new SecurityEngine([blockRule]);
    expect(
      engine.check(makeRequest('x', {}), fullAutonomyConfig()).decision,
    ).toBe('block');
  });

  it('defaults to supervised when autonomy is missing', () => {
    const engine = new SecurityEngine([escalateRule]);
    const cfg = {} as AppConfig;
    expect(engine.check(makeRequest('x', {}), cfg).decision).toBe('escalate');
  });
});

describe('SecurityEngine — add/remove rules', () => {
  it('addRule inserts and re-sorts by priority', () => {
    const engine = new SecurityEngine([
      {
        id: 'a',
        name: 'a',
        toolPattern: '*',
        action: 'allow',
        priority: 10,
        enabled: true,
      },
    ]);
    expect(engine.check(makeRequest('x', {}), supervisedConfig()).ruleId).toBe(
      'a',
    );
    engine.addRule({
      id: 'b',
      name: 'b',
      toolPattern: '*',
      action: 'block',
      priority: 100,
      enabled: true,
    });
    expect(engine.check(makeRequest('x', {}), supervisedConfig()).ruleId).toBe(
      'b',
    );
  });

  it('removeRule drops by id', () => {
    const engine = new SecurityEngine([
      {
        id: 'a',
        name: 'a',
        toolPattern: '*',
        action: 'block',
        priority: 100,
        enabled: true,
      },
    ]);
    engine.removeRule('a');
    expect(
      engine.check(makeRequest('x', {}), supervisedConfig()).decision,
    ).toBe('allow');
  });
});

describe('SecurityEngine — default decision', () => {
  it('returns allow with "no matching rules" when nothing matches', () => {
    const engine = new SecurityEngine([]);
    const result = engine.check(makeRequest('x', {}), supervisedConfig());
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBeUndefined();
    expect(result.reason).toMatch(/No matching/);
  });
});

describe('getSecurityEngine / setSecurityEngine (singleton)', () => {
  it('getSecurityEngine returns a shared default engine', () => {
    const a = getSecurityEngine();
    const b = getSecurityEngine();
    expect(a).toBe(b);
  });

  it('setSecurityEngine swaps the singleton', () => {
    const original = getSecurityEngine();
    const custom = new SecurityEngine([]);
    setSecurityEngine(custom);
    expect(getSecurityEngine()).toBe(custom);
    // restore for other suites
    setSecurityEngine(original);
  });
});

// ── built-in rule set ───────────────────────────────────────────────

describe('DEFAULT_SECURITY_RULES — built-in detectors', () => {
  const engine = new SecurityEngine();

  it('blocks destructive exec (rm -rf, mkfs, dd of=/dev/, /etc/shadow)', () => {
    for (const cmd of [
      'rm -rf /',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda',
      'cat /etc/shadow',
    ]) {
      const r = engine.check(
        makeRequest('sandbox.exec', { command: cmd }),
        supervisedConfig(),
      );
      expect(r.decision).toBe('block');
      expect(r.ruleId).toBe('sec-001');
    }
  });

  it('blocks path traversal in sandbox tools', () => {
    for (const path of ['../../etc/passwd', '/etc/passwd', '/root/.ssh']) {
      const r = engine.check(
        makeRequest('sandbox.read', { path }),
        supervisedConfig(),
      );
      expect(r.decision).toBe('block');
      expect(r.ruleId).toBe('sec-002');
    }
  });

  it('escalates dangerous permission ops (chmod 777) under supervised', () => {
    const r = engine.check(
      makeRequest('sandbox.exec', { command: 'chmod 777 file' }),
      supervisedConfig(),
    );
    expect(r.decision).toBe('escalate');
    expect(r.ruleId).toBe('sec-003');
  });

  it('suppresses chmod 777 escalation under full autonomy', () => {
    const r = engine.check(
      makeRequest('sandbox.exec', { command: 'chmod 777 file' }),
      fullAutonomyConfig(),
    );
    expect(r.decision).toBe('allow');
  });

  it('escalates network ops (curl/wget/...) under supervised', () => {
    const r = engine.check(
      makeRequest('sandbox.exec', { command: 'curl https://x.test' }),
      supervisedConfig(),
    );
    expect(r.decision).toBe('escalate');
    expect(r.ruleId).toBe('sec-004');
  });

  it('allows benign exec', () => {
    const r = engine.check(
      makeRequest('sandbox.exec', { command: 'ls -la' }),
      supervisedConfig(),
    );
    expect(r.decision).toBe('allow');
  });

  it('default rules are sorted by descending priority', () => {
    const priorities = DEFAULT_SECURITY_RULES.map((r) => r.priority);
    const sorted = [...priorities].sort((a, b) => b - a);
    expect(priorities).toEqual(sorted);
  });
});
