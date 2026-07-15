/**
 * Tests for the L2 IM confirmation callback.
 *
 * The route was previously broken: it updated task status but never
 * forwarded the verdict to the daemon (forwardL2Confirm) nor resolved
 * the Web-side decision. The agent loop therefore stayed blocked until
 * its L2 timeout. These tests pin the fix: every action branch must
 * (1) forward to the daemon with the right action/pattern/duration,
 * (2) resolve or deny the decision in the queue.
 *
 * Run via: yarn test app/api/agentd/v1/l2-confirm/route.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
// forwardL2Confirm is the crux of the fix — capture its calls.
const forwardL2ConfirmMock = vi.fn(async () => undefined);

vi.mock('@/lib/extra/agent/agentd-client', () => ({
  forwardL2Confirm: forwardL2ConfirmMock,
}));

vi.mock('@/lib/core/db/agentd', () => ({
  updateTaskStatus: vi.fn(async () => undefined),
}));

vi.mock('@/lib/core/kv/config', () => ({
  getConfig: vi.fn(async () => ({ channels: {} })),
}));

vi.mock('@/lib/extra/channels/register-channels', () => ({
  ensureNotificationChannels: vi.fn(() => []),
}));

// DecisionQueue stub: tiny in-memory stand-in so resolve/deny are observable.
const resolveMock = vi.fn(async () => null);
const denyMock = vi.fn(async () => null);
const decisions = new Map<string, unknown>();

// Notification manager singleton state — must be reset between tests,
// otherwise markDecisionProcessed() from one test dedupes the next.
const processed = new Set<string>();
const ctxs = new Map<string, unknown>();

vi.mock('@/lib/security/l2-index', () => ({
  getDecisionQueue: () => ({
    get: (id: string) => decisions.get(id) ?? null,
    resolve: resolveMock,
    deny: denyMock,
  }),
}));

vi.mock('@/lib/extra/channels/notification-manager', () => ({
  getNotificationManager: () => ({
    isDecisionProcessed: async (id: string) => processed.has(id),
    markDecisionProcessed: async (id: string) => {
      processed.add(id);
    },
    getL2Context: (id: string) => ctxs.get(id) ?? undefined,
    setL2Context: (id: string, ctx: unknown) => ctxs.set(id, ctx),
    sendL2TimeInputPrompt: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

// Dynamic import('@/lib/core/db/notification') inside the route.
vi.mock('@/lib/core/db/notification', () => ({
  getNotificationPreferences: async () => ({
    preferredChannel: 'telegram',
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function setDecision(decisionId: string, overrides: Record<string, unknown> = {}) {
  decisions.set(decisionId, {
    decisionId,
    type: 'l2_auth',
    taskId: 'task-1',
    sessionId: 'sess-1',
    command: 'rm -rf /tmp/x',
    status: 'sent',
    ...overrides,
  });
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('./route');
  return POST(new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
}

const baseBody = {
  taskId: 'task-1',
  decisionId: 'dec-1',
  chatId: 'chat-1',
  userId: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  decisions.clear();
  processed.clear();
  ctxs.clear();
  // Re-seed a cached decision for each test by default.
  setDecision('dec-1');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('l2-confirm: pass_once', () => {
  it('forwards pass_once to the daemon with pattern and duration=once', async () => {
    const res = await post({ ...baseBody, action: 'pass_once' });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(forwardL2ConfirmMock).toHaveBeenCalledTimes(1);
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'pass_once',
      pattern: 'rm -rf /tmp/x',
      duration: 'once',
      // No nodeId on the seeded decision → forwarded as undefined, so
      // agentd-client falls back to default single-node resolution.
      nodeId: undefined,
    });
  });

  it('resolves the Web-side decision', async () => {
    await post({ ...baseBody, action: 'pass_once' });
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(denyMock).not.toHaveBeenCalled();
  });
});

describe('l2-confirm: reject_once', () => {
  it('forwards reject_once to the daemon and denies the decision', async () => {
    const res = await post({ ...baseBody, action: 'reject_once' });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'reject_once',
      pattern: 'rm -rf /tmp/x',
      duration: 'once',
    });
    expect(denyMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

describe('l2-confirm: pass_until', () => {
  it('prompts for time on first click (no forward yet)', async () => {
    const res = await post({ ...baseBody, action: 'pass_until' });
    const json = await res.json();

    expect(json.data.awaitingTimeInput).toBe(true);
    expect(forwardL2ConfirmMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('forwards pass_until with the user duration after time input', async () => {
    const res = await post({
      ...baseBody,
      action: 'pass_until',
      timeInput: '01000000', // 1 hour
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'pass_until',
      pattern: 'rm -rf /tmp/x',
      duration: '01000000',
    });
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it('forwards pass_until with duration=always', async () => {
    await post({
      ...baseBody,
      action: 'pass_until',
      timeInput: 'always',
    });
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'pass_until',
      pattern: 'rm -rf /tmp/x',
      duration: 'always',
    });
  });

  it('rejects malformed time input', async () => {
    const res = await post({
      ...baseBody,
      action: 'pass_until',
      timeInput: 'nope',
    });
    expect(res.status).toBe(400);
    expect(forwardL2ConfirmMock).not.toHaveBeenCalled();
  });
});

describe('l2-confirm: reject_until', () => {
  it('forwards reject_until and denies the decision', async () => {
    const res = await post({
      ...baseBody,
      action: 'reject_until',
      timeInput: '00010000', // 1 day
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'reject_until',
      pattern: 'rm -rf /tmp/x',
      duration: '00010000',
    });
    expect(denyMock).toHaveBeenCalledTimes(1);
  });
});

describe('l2-confirm: dedup', () => {
  it('skips forward + resolve on duplicate click', async () => {
    await post({ ...baseBody, action: 'pass_once' });
    await post({ ...baseBody, action: 'pass_once' });

    // Second click is deduped — forward fires only once.
    expect(forwardL2ConfirmMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });
});

describe('l2-confirm: node pinning', () => {
  it('forwards the decision nodeId so the verdict routes back to the raising daemon', async () => {
    // A multi-node install: the L2 was raised by node "node-b", stored on
    // the decision at enqueue time. The verdict must carry that nodeId so
    // agentd-client routes it to node-b's /api/v1/l2-confirm, not nodes[0].
    setDecision('dec-1', { nodeId: 'node-b' });

    await post({ ...baseBody, action: 'pass_once' });

    expect(forwardL2ConfirmMock).toHaveBeenCalledTimes(1);
    expect(forwardL2ConfirmMock).toHaveBeenCalledWith({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'pass_once',
      pattern: 'rm -rf /tmp/x',
      duration: 'once',
      nodeId: 'node-b',
    });
  });
});

describe('l2-confirm: missing decision in cache', () => {
  it('still forwards to daemon when decision expired out of cache', async () => {
    decisions.delete('dec-1');
    // L2 context provides the taskId fallback for pattern.
    const { getNotificationManager } = await import(
      '@/lib/extra/channels/notification-manager'
    );
    getNotificationManager().setL2Context('dec-1', {
      action: 'pass_once',
      taskId: 'rm -rf /tmp/x',
      decisionId: 'dec-1',
      awaitingTimeInput: false,
      createdAt: new Date().toISOString(),
    });

    await post({ ...baseBody, action: 'pass_once' });

    // Queue resolve skipped (decision gone), but forward still attempted
    // so the daemon agent loop unblocks.
    expect(forwardL2ConfirmMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(denyMock).not.toHaveBeenCalled();
  });
});
