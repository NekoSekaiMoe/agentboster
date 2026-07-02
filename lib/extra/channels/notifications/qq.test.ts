import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyL2Link } from '@/lib/security/l2-link';
import { QQNotificationChannel } from './qq';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
});

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  }
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  }
});

const baseDecisionPayload = {
  type: 'decision' as const,
  taskId: 'task_qq',
  decisionId: 'dec_qq_1',
  title: 'High-risk command',
  body: 'rm -rf /tmp/build',
  command: 'rm -rf /tmp/build',
  score: 0.88,
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
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    // QQ OAuth endpoint shape vs message-send endpoint shape.
    const payload =
      u.includes('getAppAccessToken')
        ? { access_token: 'tok', expires_in: 7200 }
        : { id: 'msg_1' };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

describe('QQNotificationChannel — L2 markdown-link fallback', () => {
  it('renders each L2 action as a signed markdown link', async () => {
    const chan = new QQNotificationChannel({
      appId: 'a',
      appSecret: 's',
    });
    const fetchMock = captureFetch();
    try {
      const result = await chan.send('chan_1', baseDecisionPayload);
      expect(result.success).toBe(true);
      // First call is getAppAccessToken, second is the actual send.
      const sendCall = fetchMock.calls.find((c) =>
        c.url.includes('/channels/'),
      );
      expect(sendCall).toBeDefined();
      const content = String(sendCall?.body.content);

      // Each of the four actions should appear as a markdown link
      // pointing at /api/l2/<decisionId>/<action>?t=...&s=...
      for (const action of [
        'pass_once',
        'pass_until',
        'reject_once',
        'reject_until',
      ]) {
        const re = new RegExp(
          String.raw`\[.*\]\(https://app\.example\.test/api/l2/dec_qq_1/${action}\?t=\d+&s=[0-9a-f]+\)`,
        );
        expect(content).toMatch(re);
      }
    } finally {
      fetchMock.restore();
    }
  });

  it('emits links whose signatures pass verifyL2Link', async () => {
    const chan = new QQNotificationChannel({
      appId: 'a',
      appSecret: 's',
    });
    const fetchMock = captureFetch();
    try {
      await chan.send('chan_1', baseDecisionPayload);
      const sendCall = fetchMock.calls.find((c) =>
        c.url.includes('/channels/'),
      );
      const content = String(sendCall?.body.content);
      const urlMatches = [
        ...content.matchAll(
          /https:\/\/app\.example\.test\/api\/l2\/dec_qq_1\/(pass_once|pass_until|reject_once|reject_until)\?t=(\d+)&s=([0-9a-f]+)/g,
        ),
      ];
      expect(urlMatches.length).toBe(4);
      for (const m of urlMatches) {
        const [, action, expires, signature] = m;
        const result = verifyL2Link({
          decisionId: 'dec_qq_1',
          action,
          expiresParam: expires,
          signatureParam: signature,
        });
        expect(result.ok).toBe(true);
      }
    } finally {
      fetchMock.restore();
    }
  });

  it('non-decision payloads do not carry L2 links', async () => {
    const chan = new QQNotificationChannel({
      appId: 'a',
      appSecret: 's',
    });
    const fetchMock = captureFetch();
    try {
      await chan.send('chan_1', {
        type: 'completion',
        taskId: 'task_x',
        status: 'completed',
        title: 'Done',
        summary: 'all good',
        channelFallback: [],
      });
      const sendCall = fetchMock.calls.find((c) =>
        c.url.includes('/channels/'),
      );
      const content = String(sendCall?.body.content);
      expect(content).not.toContain('/api/l2/');
    } finally {
      fetchMock.restore();
    }
  });
});
