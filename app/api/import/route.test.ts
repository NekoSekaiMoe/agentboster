import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

// biome-ignore lint: test mocks
const patchConfigMock = vi.fn<any>(async () => undefined);
// biome-ignore lint: test mocks
const setConfigMock = vi.fn<any>(async () => undefined);

vi.mock('@/lib/core/kv/config', () => ({
  patchConfig: (cfg: unknown) => patchConfigMock(cfg),
  setConfig: (cfg: unknown) => setConfigMock(cfg),
}));

// biome-ignore lint: test mocks
const upsertBuiltinMemoryRowMock = vi.fn<any>(async () => undefined);
vi.mock('@/lib/core/db/memory/builtin', () => ({
  upsertBuiltinMemoryRow: (key: unknown, content: unknown) =>
    upsertBuiltinMemoryRowMock(key, content),
}));

// biome-ignore lint: test mocks
const createL0RuleMock = vi.fn<any>(async () => ({ id: 'r1' }));
const listL0RulesMock = vi.fn(
  async (): Promise<
    Array<{
      agentId: string;
      pattern: string;
      type: string;
      scope: string;
      action: string;
    }>
  > => [],
);
vi.mock('@/lib/core/db/agentd', () => ({
  createL0Rule: (data: unknown) => createL0RuleMock(data),
  listL0Rules: () => listL0RulesMock(),
}));

// biome-ignore lint: test mocks
const upsertLongTermMemoryMock = vi.fn<any>(async () => undefined);
// biome-ignore lint: test mocks
const createLongTermMemoryMock = vi.fn<any>(async () => undefined);
vi.mock('@/lib/memory/long-term', () => ({
  upsertLongTermMemory: (data: unknown) => upsertLongTermMemoryMock(data),
  createLongTermMemory: (data: unknown) => createLongTermMemoryMock(data),
}));

let isAdmin = true;
// biome-ignore lint: test mocks
const requireAdminAccessMock = vi.fn<any>(async () => {
  if (!isAdmin) throw new Error('Forbidden');
});

vi.mock('@/lib/auth/access', () => ({
  requireAdminAccess: (cookies: unknown) => requireAdminAccessMock(cookies),
}));

vi.mock('@/lib/auth', () => ({
  readAuthSessionFromCookies: vi.fn(async () => ({
    userId: 'user-1',
    role: 'user',
  })),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(body: unknown, query = '') {
  return new Request(`http://localhost/api/import${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/import', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    isAdmin = true;
    listL0RulesMock.mockResolvedValue([]);
    ({ POST } = await import('./route'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('admin access', () => {
    it('rejects config import for non-admin', async () => {
      isAdmin = false;
      const res = await POST(
        makeRequest({ config: { models: { openai: {} } } }),
      );
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.results.config.success).toBe(false);
      expect(json.results.config.error).toContain('Forbidden');
      expect(patchConfigMock).not.toHaveBeenCalled();
    });

    it('rejects builtinMemories import for non-admin', async () => {
      isAdmin = false;
      const res = await POST(
        makeRequest({
          builtinMemories: [{ key: 'AGENTS', content: 'test' }],
        }),
      );
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.results.builtinMemories.success).toBe(false);
    });

    it('rejects l0Rules import for non-admin', async () => {
      isAdmin = false;
      const res = await POST(
        makeRequest({
          l0Rules: [{ pattern: 'rm -rf', type: 'command', action: 'block' }],
        }),
      );
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.results.l0Rules.success).toBe(false);
    });
  });

  describe('merge vs replace', () => {
    it('calls patchConfig when merge=true (default)', async () => {
      const cfg = { models: { test: true } };
      const res = await POST(makeRequest({ config: cfg }));
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(patchConfigMock).toHaveBeenCalledWith(cfg);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it('calls setConfig when merge=false', async () => {
      const cfg = { models: { test: true } };
      const res = await POST(makeRequest({ config: cfg }, '?merge=false'));
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(setConfigMock).toHaveBeenCalledWith(cfg);
      expect(patchConfigMock).not.toHaveBeenCalled();
    });
  });

  describe('partial failure aggregation', () => {
    it('returns ok=false when one partition fails', async () => {
      isAdmin = false;
      const res = await POST(
        makeRequest({
          config: { models: {} },
          longTermMemories: [{ key: 'k1', content: 'hello' }],
        }),
      );
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.results.config.success).toBe(false);
      expect(json.results.longTermMemories.success).toBe(true);
      expect(json.results.longTermMemories.count).toBe(1);
    });

    it('returns ok=true when all partitions succeed', async () => {
      const res = await POST(
        makeRequest({
          config: { models: {} },
          l0Rules: [{ pattern: 'rm', type: 'command', action: 'block' }],
        }),
      );
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.results.config.success).toBe(true);
      expect(json.results.l0Rules.success).toBe(true);
    });
  });

  describe('L0 rule dedup', () => {
    it('skips duplicate rules', async () => {
      listL0RulesMock.mockResolvedValue([
        {
          agentId: 'global',
          pattern: 'rm -rf',
          type: 'command',
          scope: 'global',
          action: 'block',
        },
      ]);
      const res = await POST(
        makeRequest({
          l0Rules: [
            { pattern: 'rm -rf', type: 'command', action: 'block' },
            { pattern: 'curl', type: 'command', action: 'warn' },
          ],
        }),
      );
      const json = await res.json();
      expect(json.results.l0Rules.success).toBe(true);
      expect(json.results.l0Rules.count).toBe(1);
      expect(createL0RuleMock).toHaveBeenCalledTimes(1);
      expect(createL0RuleMock).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: 'curl' }),
      );
    });

    it('deduplicates within the same import batch', async () => {
      const res = await POST(
        makeRequest({
          l0Rules: [
            { pattern: 'rm', type: 'command', action: 'block' },
            { pattern: 'rm', type: 'command', action: 'block' },
          ],
        }),
      );
      const json = await res.json();
      expect(json.results.l0Rules.count).toBe(1);
      expect(createL0RuleMock).toHaveBeenCalledTimes(1);
    });
  });
});
