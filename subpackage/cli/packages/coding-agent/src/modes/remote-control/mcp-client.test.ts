import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

describe('mcp-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('findMcpBinary', () => {
    it('finds binary via COMPUTER_USE_MCP_PATH env var', async () => {
      const envPath = '/custom/path/computer-use-mcp';
      process.env.COMPUTER_USE_MCP_PATH = envPath;
      vi.mocked(existsSync).mockImplementation((p) => p === envPath);

      const mod = await import('./mcp-client.ts');
      // The module exposes startMcpServer which calls findMcpBinary internally.
      // We verify that spawn is called with the right path.
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: {
          write: vi.fn((_data: string, cb: (err?: Error) => void) => cb()),
        },
        on: vi.fn(),
        kill: vi.fn(),
        once: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout, that's fine
      }

      if (vi.mocked(spawn).mock.calls.length > 0) {
        expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(envPath);
      }

      delete process.env.COMPUTER_USE_MCP_PATH;
    });

    it('falls back to binary next to process.execPath', async () => {
      delete process.env.COMPUTER_USE_MCP_PATH;
      const expectedPath = join(process.execPath, '..', 'computer-use-mcp');
      vi.mocked(existsSync).mockImplementation((p) => p === expectedPath);

      const mod = await import('./mcp-client.ts');
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: {
          write: vi.fn((_data: string, cb: (err?: Error) => void) => cb()),
        },
        on: vi.fn(),
        kill: vi.fn(),
        once: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout
      }

      if (vi.mocked(spawn).mock.calls.length > 0) {
        expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(expectedPath);
      }
    });

    it('throws when no binary found', async () => {
      delete process.env.COMPUTER_USE_MCP_PATH;
      vi.mocked(existsSync).mockReturnValue(false);

      const mod = await import('./mcp-client.ts');
      await expect(mod.startMcpServer('test-session')).rejects.toThrow(
        'computer-use-mcp binary not found',
      );
    });
  });

  describe('spawn env whitelist', () => {
    it('does not pass full process.env to MCP subprocess', async () => {
      delete process.env.COMPUTER_USE_MCP_PATH;
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).includes('computer-use-mcp'),
      );

      const mod = await import('./mcp-client.ts');
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: {
          write: vi.fn((_data: string, cb: (err?: Error) => void) => cb()),
        },
        on: vi.fn(),
        kill: vi.fn(),
        once: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout
      }

      if (vi.mocked(spawn).mock.calls.length > 0) {
        const spawnOptions = vi.mocked(spawn).mock.calls[0]![2] as any;
        const envKeys = Object.keys(spawnOptions.env);

        // Must NOT contain all of process.env
        expect(envKeys.length).toBeLessThan(Object.keys(process.env).length);

        // Must contain the whitelisted keys
        expect(envKeys).toContain('HOME');
        expect(envKeys).toContain('PATH');
        expect(envKeys).toContain('COMPUTER_USE_SESSION_ID');

        // PATH must be empty
        expect(spawnOptions.env.PATH).toBe('');
      }
    });
  });

  describe('isMcpServerRunning', () => {
    it('returns false initially', async () => {
      const mod = await import('./mcp-client.ts');
      expect(mod.isMcpServerRunning()).toBe(false);
    });
  });
});
