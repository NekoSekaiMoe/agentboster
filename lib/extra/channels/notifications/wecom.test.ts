import { describe, expect, it } from 'vitest';
import { WecomNotificationChannel } from './wecom';

const baseDecisionPayload = {
  type: 'decision' as const,
  taskId: 'task_abc',
  decisionId: 'dec_123',
  title: 'High-risk command',
  body: 'rm -rf /tmp/build',
  command: 'rm -rf /tmp/build',
  score: 0.92,
  reason: 'destructive',
  options: ['pass_once', 'pass_until', 'reject_once', 'reject_until'] as [
    'pass_once',
    'pass_until',
    'reject_once',
    'reject_until',
  ],
  expiresAt: '2026-01-01T00:00:00Z',
};

function captureFetch() {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('gettoken')) {
      return new Response(
        JSON.stringify({ errcode: 0, access_token: 'tok', expires_in: 7200 }),
        { status: 200 },
      );
    }
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ errcode: 0, msgid: 'm1' }), {
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

describe('WecomNotificationChannel — L2 template_card', () => {
  it('emits template_card with button_list keys matching l2: payload', async () => {
    const chan = new WecomNotificationChannel({
      corpId: 'c',
      secret: 's',
      agentId: '1000001',
    });
    const fetchMock = captureFetch();
    try {
      const result = await chan.send('user1', baseDecisionPayload);
      expect(result.success).toBe(true);
      expect(fetchMock.calls).toHaveLength(1);
      const body = fetchMock.calls[0].body;
      expect(body.msgtype).toBe('template_card');
      const card = body.template_card as Record<string, unknown>;
      expect(card.card_type).toBe('text_notice');
      const btns = card.button_list as Array<{ key: string; text: string }>;
      expect(btns.length).toBe(4);
      for (const b of btns) {
        expect(b.key).toMatch(
          /^l2:(pass_once|pass_until|reject_once|reject_until):task_abc:dec_123$/,
        );
      }
      // task_id is mandatory for template_card dispatch.
      expect(card.task_id).toBe('task_abc:dec_123');
    } finally {
      fetchMock.restore();
    }
  });

  it('non-decision payloads still send as text (no template_card)', async () => {
    const chan = new WecomNotificationChannel({
      corpId: 'c',
      secret: 's',
      agentId: '1000001',
    });
    const fetchMock = captureFetch();
    try {
      await chan.send('user1', {
        type: 'completion',
        taskId: 'task_x',
        status: 'completed',
        title: 'Done',
        summary: 'all good',
        channelFallback: [],
      });
      expect(fetchMock.calls).toHaveLength(1);
      expect(fetchMock.calls[0].body.msgtype).toBe('text');
    } finally {
      fetchMock.restore();
    }
  });
});
