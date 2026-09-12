import { describe, expect, it } from 'vitest';
import {
  evaluate,
  normalizeToolName,
  PermissionBroker,
  PermissionError,
  toolRisk,
  validateSessionId,
  validateToolName,
  type PermissionBrokerOptions,
  type ResolvedAuditFields,
} from './broker';
import type {
  PermissionMode,
  PermissionRequest,
  PermissionRisk,
  PermissionResolveOutcome,
} from './types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface ResolvedEvent {
  requestId: string;
  outcome: PermissionResolveOutcome;
  audit?: ResolvedAuditFields;
}

function createBroker(
  overrides: Partial<
    PermissionBrokerOptions & { timeoutMs: number; denyCooldownMs: number }
  > = {},
) {
  const { timeoutMs, denyCooldownMs, ...rest } = overrides;
  const emittedRequests: PermissionRequest[] = [];
  const resolved: ResolvedEvent[] = [];
  const granted: Array<[string, string, string]> = [];
  const grants = new Map<string, Set<string>>();
  const requestWaiters: Array<() => void> = [];

  const broker = new PermissionBroker({
    getPersistentGrant: () => undefined,
    getSessionGrants: (sessionId) => grants.get(sessionId) ?? new Set(),
    grantSession: (sessionId, toolName, source) => {
      granted.push([sessionId, toolName, source]);
      const set = grants.get(sessionId) ?? new Set<string>();
      set.add(toolName);
      grants.set(sessionId, set);
    },
    isResponderAvailable: () => true,
    emitRequest: (request) => {
      emittedRequests.push(request);
      for (const waiter of requestWaiters.splice(0)) waiter();
    },
    emitResolved: (requestId, outcome, audit) => {
      resolved.push({ requestId, outcome, audit });
    },
    ...rest,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(denyCooldownMs !== undefined ? { denyCooldownMs } : {}),
  });

  return {
    broker,
    emittedRequests,
    resolved,
    granted,
    waitForRequest: () =>
      new Promise<void>((resolve) => {
        if (emittedRequests.length > 0) resolve();
        else requestWaiters.push(resolve);
      }),
    lastRequest: () => emittedRequests[emittedRequests.length - 1],
    lastRequestId: () => emittedRequests[emittedRequests.length - 1].id,
  };
}

describe('toolRisk (fail-closed classification)', () => {
  it('low-risk read-only tools', () => {
    for (const t of ['read', 'glob', 'grep', 'find', 'ls', 'Read', ' LS ']) {
      expect(toolRisk(t)).toBe('low');
    }
  });

  it('high-risk mutating tools', () => {
    for (const t of ['write', 'edit', 'bash']) {
      expect(toolRisk(t)).toBe('high');
    }
  });

  it('unknown tools are medium, never low', () => {
    expect(toolRisk('mcp_some_server')).toBe('medium');
    expect(toolRisk('')).toBe('medium');
  });
});

describe('evaluate (ordered decision chain)', () => {
  const allow = {
    sessionId: 's1',
    toolName: 'bash',
    decision: 'allow' as const,
    updatedAt: 0,
  };
  const deny = { ...allow, decision: 'deny' as const };

  it('1. persistent deny is absolute — wins over everything', () => {
    expect(evaluate('bash', 'low', new Set(['bash']), deny, 'auto')).toBe(
      'deny',
    );
  });

  it('2. session grant beats persistent allow and mode', () => {
    expect(evaluate('bash', 'high', new Set(['bash']), allow, 'ask')).toBe(
      'allow-session',
    );
  });

  it('3. persistent allow beats low-risk / mode rules', () => {
    expect(evaluate('bash', 'high', new Set(), allow, 'ask')).toBe(
      'allow-session',
    );
  });

  it('4. low risk auto-allows in every mode', () => {
    for (const mode of ['ask', 'accept-edits', 'auto'] as PermissionMode[]) {
      expect(evaluate('read', 'low', new Set(), undefined, mode)).toBe(
        'allow-once',
      );
    }
  });

  it('5. auto mode allows any tool', () => {
    expect(evaluate('bash', 'high', new Set(), undefined, 'auto')).toBe(
      'allow-once',
    );
  });

  it('6. accept-edits only covers write/edit', () => {
    expect(
      evaluate('write', 'high', new Set(), undefined, 'accept-edits'),
    ).toBe('allow-once');
    expect(evaluate('bash', 'high', new Set(), undefined, 'accept-edits')).toBe(
      'ask',
    );
  });

  it('7. otherwise ask (default-ask, not default-deny)', () => {
    expect(evaluate('bash', 'high', new Set(), undefined, 'ask')).toBe('ask');
  });
});

describe('PermissionBroker.request', () => {
  it('returns allow-once for low-risk tools without prompting', async () => {
    const h = createBroker();
    await expect(
      h.broker.request({
        sessionId: 's1',
        toolName: 'Read',
        argsPreview: 'x',
        reason: 'r',
      }),
    ).resolves.toBe('allow-once');
    expect(h.emittedRequests).toHaveLength(0);
  });

  it('prompts for high-risk tools and resolves on allow-session', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'rm -rf /tmp/x',
      reason: 'cleanup',
    });
    await h.waitForRequest();
    expect(h.lastRequest().argsPreview).toBe('rm -rf /tmp/x');
    h.broker.respond(h.lastRequestId(), 'allow-session');
    await expect(pending).resolves.toBe('allow-session');
    expect(h.granted).toContainEqual(['s1', 'bash', 'user-prompt']);
  });

  it('truncates the args preview to ARGS_PREVIEW_MAX_CHARS', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x'.repeat(5_000),
      reason: 'r',
    });
    await h.waitForRequest();
    expect(h.lastRequest().argsPreview.length).toBe(2_000);
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('re-derives an invalid declared risk (fail-closed to toolRisk)', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      risk: 'cosmic' as unknown as PermissionRisk,
      argsPreview: 'x',
      reason: 'r',
      mode: 'ask',
    });
    await h.waitForRequest();
    expect(h.lastRequest().risk).toBe('high'); // re-derived, not trusted
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('fails closed when the responder is unavailable', async () => {
    const h = createBroker({ isResponderAvailable: () => false });
    await expect(
      h.broker.request({
        sessionId: 's1',
        toolName: 'bash',
        argsPreview: 'x',
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_UNAVAILABLE' });
  });

  it('times out into a deny with an audit trail', async () => {
    const h = createBroker({ timeoutMs: 20 });
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_TIMEOUT' });
    expect(h.resolved[0]?.outcome).toBe('timeout');
    expect(h.resolved[0]?.audit?.decision).toBe('deny');
    expect(h.resolved[0]?.audit?.errorCode).toBe('PERMISSION_TIMEOUT');
  });

  it('cooldown: a denied tool rejects immediately without re-prompting', async () => {
    const h = createBroker({ denyCooldownMs: 10_000 });
    const first = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(first).rejects.toMatchObject({ code: 'TOOL_DENIED' });

    await expect(
      h.broker.request({
        sessionId: 's1',
        toolName: 'bash',
        argsPreview: 'x',
        reason: 'r2',
      }),
    ).rejects.toMatchObject({
      code: 'TOOL_DENIED',
      message: /recently denied/,
    });
    expect(h.emittedRequests).toHaveLength(1);
  });

  it('shared cooldownScope cools down related tools as one domain', async () => {
    const h = createBroker({ denyCooldownMs: 10_000 });
    const first = h.broker.request({
      sessionId: 's1',
      toolName: 'browser_read',
      argsPreview: 'x',
      reason: 'r',
      cooldownScope: 'browser',
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(first).rejects.toMatchObject({ code: 'TOOL_DENIED' });

    await expect(
      h.broker.request({
        sessionId: 's1',
        toolName: 'browser_advanced',
        argsPreview: 'x',
        reason: 'r2',
        cooldownScope: 'browser',
      }),
    ).rejects.toMatchObject({ message: /recently denied/ });
  });

  it('treats unknown respond() decisions as deny (fail-closed)', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'allow-always' as never);
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('sessionOnly + allow-once is meaningless → deny', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'browser_interact',
      argsPreview: 'x',
      reason: 'r',
      sessionOnly: true,
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'allow-once');
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('external path roots escalate to ask unless mode is auto', async () => {
    const h = createBroker();
    // accept-edits + external path → ask (not auto-allowed like usual edits).
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'write',
      argsPreview: '/etc/hosts',
      reason: 'r',
      mode: 'accept-edits',
      pathRoot: 'external',
    });
    await h.waitForRequest();
    expect(h.lastRequest().toolName).toBe('write');
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('joins an in-flight prompt for the same session+tool', async () => {
    const h = createBroker();
    const a = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    const b = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'y',
      reason: 'r2',
    });
    expect(h.emittedRequests).toHaveLength(1);
    h.broker.respond(h.lastRequestId(), 'allow-session');
    await expect(a).resolves.toBe('allow-session');
    await expect(b).resolves.toBe('allow-session');
  });

  it('cancellation is authoritative over a racing response', async () => {
    const h = createBroker();
    const pending = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    const id = h.lastRequestId();
    h.broker.cancelSession('s1');
    // A late response arrives after cancellation — the caller was already
    // rejected (cancel wins) and the response is stale.
    expect(() => h.broker.respond(id, 'allow-session')).toThrow(
      PermissionError,
    );
    await expect(pending).rejects.toMatchObject({
      code: 'PERMISSION_UNAVAILABLE',
    });
  });

  it('persistent deny throws before any prompt', async () => {
    const h = createBroker({
      getPersistentGrant: (_sessionId, toolName) =>
        toolName === 'bash'
          ? {
              sessionId: 's1',
              toolName: 'bash',
              decision: 'deny',
              updatedAt: 0,
            }
          : undefined,
    });
    await expect(
      h.broker.request({
        sessionId: 's1',
        toolName: 'bash',
        argsPreview: 'x',
        reason: 'r',
        mode: 'auto',
      }),
    ).rejects.toMatchObject({
      code: 'TOOL_DENIED',
      message: /persistent policy/,
    });
    expect(h.emittedRequests).toHaveLength(0);
  });

  it('serializes prompts: second request queues until the first resolves', async () => {
    const h = createBroker();
    const a = h.broker.request({
      sessionId: 's1',
      toolName: 'write',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    const b = h.broker.request({
      sessionId: 's1',
      toolName: 'edit',
      argsPreview: 'x',
      reason: 'r',
    });
    // Only the first prompt is active; the second waits in the queue.
    expect(h.emittedRequests).toHaveLength(1);
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(a).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await h.waitForRequest(); // second prompt activates
    h.broker.respond(h.lastRequestId(), 'allow-once');
    await expect(b).resolves.toBe('allow-once');
  });
});

describe('cancelAll / cancelSession scoping', () => {
  it('cancelAll with a tool matcher spares unmatched pendings', async () => {
    const h = createBroker();
    const a = h.broker.request({
      sessionId: 's1',
      toolName: 'write',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    const b = h.broker.request({
      sessionId: 's1',
      toolName: 'edit',
      argsPreview: 'x',
      reason: 'r',
    });
    h.broker.cancelAll((toolName) => toolName === 'write');
    await expect(a).rejects.toMatchObject({ code: 'PERMISSION_UNAVAILABLE' });
    h.broker.respond(h.lastRequestId(), 'allow-once');
    await expect(b).resolves.toBe('allow-once');
  });

  it('cancelSession clears cooldowns for that session only', async () => {
    const h = createBroker({ denyCooldownMs: 60_000 });
    const first = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(first).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    h.broker.cancelSession('s1');
    // Cooldown cleared → prompts again instead of auto-denying.
    const second = h.broker.request({
      sessionId: 's1',
      toolName: 'bash',
      argsPreview: 'x',
      reason: 'r',
    });
    await h.waitForRequest();
    h.broker.respond(h.lastRequestId(), 'deny');
    await expect(second).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });
});

describe('validators', () => {
  it('validateToolName enforces the charset (after normalization)', () => {
    expect(validateToolName(' Bash ')).toBe('bash');
    expect(() => validateToolName('bash;rm')).toThrow(PermissionError);
    expect(() => validateToolName('bash\x00x')).toThrow(PermissionError);
  });

  it('validateSessionId rejects control chars and overlong ids', () => {
    expect(validateSessionId(' s1 ')).toBe('s1');
    expect(() => validateSessionId('s\n1')).toThrow(PermissionError);
    expect(() => validateSessionId('a'.repeat(257))).toThrow(PermissionError);
  });

  it('normalizeToolName trims and lowercases', () => {
    expect(normalizeToolName('  WRITE ')).toBe('write');
  });
});
