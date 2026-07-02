import { describe, expect, it } from 'vitest';
import { DingtalkNotificationChannel } from './dingtalk';

const baseDecisionPayload = {
  type: 'decision' as const,
  taskId: 'task_abc',
  decisionId: 'dec_123',
  title: 'High-risk command',
  body: 'rm -rf /tmp/build',
  command: 'rm -rf /tmp/build',
  score: 0.92,
  reason: 'destructive',
  options: ['pass_once', 'pass_until', 'reject_once', 'reject_until'],
  expiresAt: '2026-01-01T00:00:00Z',
};

// Capture the fetch body so we can assert on the DingTalk msgParam shape.
function captureFetch() {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('oauth2/accessToken')) {
      return new Response(
        JSON.stringify({ accessToken: 'tok', expireIn: 7200 }),
        { status: 200 },
      );
    }
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ code: 0, processQueryKey: 'qk' }), {
      status: 200,
    });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

describe('DingtalkNotificationChannel — L2 actionCard', () => {
  it('emits sampleActionCard msgKey with btns carrying l2: payload', async () => {
    const chan = new DingtalkNotificationChannel({
      appKey: 'k',
      appSecret: 's',
      robotCode: 'r',
    });
    const fetchMock = captureFetch();
    try {
      const result = await chan.send('single:user1', baseDecisionPayload);
      expect(result.success).toBe(true);
      expect(fetchMock.calls).toHaveLength(1);
      const body = fetchMock.calls[0].body;
      expect(body.msgKey).toBe('sampleActionCard');
      const msgParam = JSON.parse(String(body.msgParam));
      const ids = msgParam.btns.map((b: { id: string }) => b.id);
      // Each btn id must match the canonical l2:<action>:<taskId>:<decisionId> shape.
      for (const id of ids) {
        expect(id).toMatch(
          /^l2:(pass_once|pass_until|reject_once|reject_until):task_abc:dec_123$/,
        );
      }
      expect(ids).toContain('l2:pass_once:task_abc:dec_123');
      expect(ids).toContain('l2:reject_until:task_abc:dec_123');
    } finally {
      fetchMock.restore();
    }
  });

  it('non-decision payloads do not use actionCard', async () => {
    const chan = new DingtalkNotificationChannel({
      appKey: 'k',
      appSecret: 's',
      robotCode: 'r',
    });
    const fetchMock = captureFetch();
    try {
      await chan.send('single:user1', {
        type: 'completion',
        taskId: 'task_x',
        status: 'completed',
        title: 'Done',
        summary: 'all good',
        channelFallback: [],
      });
      expect(fetchMock.calls).toHaveLength(1);
      expect(fetchMock.calls[0].body.msgKey).not.toBe('sampleActionCard');
    } finally {
      fetchMock.restore();
    }
  });
});
