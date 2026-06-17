import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch so the test doesn't hit Telegram.
vi.stubGlobal('fetch', vi.fn());

import { registerTelegramCommands } from '@/lib/bot/webhook';

interface SetMyCommandsBody {
  commands: Array<{ command: string; description: string }>;
  language_code?: string;
}

function capturedBodies(): SetMyCommandsBody[] {
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  return calls.map((args) => {
    const [, init] = args as [string, RequestInit];
    return JSON.parse(String(init.body)) as SetMyCommandsBody;
  });
}

describe('registerTelegramCommands', () => {
  beforeEach(() => {
    (fetch as unknown as { mockClear: () => void }).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers a default (no language_code) plus one per supported language', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await registerTelegramCommands('fake-token');

    const bodies = capturedBodies();
    const codes = bodies.map((b) => b.language_code ?? '<default>');
    // The order is: default first, then per-locale in the order of `locales`.
    // en-US → en, zh-CN → zh, zh-TW → zh (collapsed), zh-HK → zh (collapsed),
    // ja → ja, ko → ko, en-GB → not registered (no entry in mapping).
    expect(codes).toEqual(['<default>', 'en', 'zh', 'ja', 'ko']);
  });

  it('each call uses the slash.command.* description for its locale', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await registerTelegramCommands('fake-token');

    const bodies = capturedBodies();
    const zhCall = bodies.find((b) => b.language_code === 'zh');
    expect(zhCall).toBeDefined();
    const helpCmd = zhCall?.commands.find((c) => c.command === 'help');
    expect(helpCmd).toBeDefined();
    expect(helpCmd?.description.length ?? 0).toBeGreaterThan(0);
    expect(helpCmd?.description).not.toBe('Show slash command help');
  });

  it('default set is in English', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await registerTelegramCommands('fake-token');

    const bodies = capturedBodies();
    const defaultCall = bodies.find((b) => !b.language_code);
    expect(defaultCall).toBeDefined();
    const helpCmd = defaultCall?.commands.find((c) => c.command === 'help');
    expect(helpCmd?.description).toBe('Show slash command help');
  });

  it('a single language failing does not abort the rest', async () => {
    vi.mocked(fetch).mockImplementation(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.language_code === 'zh') {
          return {
            ok: true,
            json: async () => ({ ok: false, description: 'rate limited' }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as Response;
      },
    );

    await registerTelegramCommands('fake-token');

    const bodies = capturedBodies();
    expect(bodies.length).toBe(5);
  });
});
