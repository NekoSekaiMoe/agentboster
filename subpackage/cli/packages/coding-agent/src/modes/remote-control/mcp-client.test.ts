import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Build a mock ChildProcess-like object whose stdout `'data'` handler
 * emits a JSON-RPC response as soon as the test code writes the
 * corresponding request to stdin. Without this, `startMcpServer`'s
 * internal `callMcpMethod('initialize', ...)` would wait for the full
 * 30-second request timeout on every test (3 tests × 30s = 90s,
 * tripping vitest's default 30s test ceiling).
 *
 * The mock keeps a map of pending request ids → resolve callbacks by
 * observing stdin writes; when an id is written, the matching response
 * line is queued via `queueMicrotask` so the `'data'` listener is
 * already attached by the time we emit.
 */
function makeMockProcess(): {
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  stdin: {
    write: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  emitData: (line: string) => void;
} {
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  return {
    stdout: {
      on: vi.fn((_event: string, cb: (chunk: Buffer) => void) => {
        if (_event === 'data') dataListeners.push(cb);
      }),
    },
    stderr: { on: vi.fn() },
    stdin: {
      // When mcp-client writes a JSON-RPC request, echo back a success
      // response with the same id. This lets `initialize` resolve
      // promptly and `startMcpServer` return without timing out.
      write: vi.fn((data: string, cb: (err?: Error) => void) => {
        try {
          const req = JSON.parse(data.trim());
          if (typeof req.id === 'number') {
            const response = JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {},
            });
            // Defer to next tick so the `'data'` listener is attached
            // (mcp-client registers it synchronously after spawn).
            queueMicrotask(() => {
              for (const listener of dataListeners) {
                listener(Buffer.from(`${response}\n`));
              }
            });
          }
        } catch {
          // Not a JSON-RPC line — ignore (test doesn't care).
        }
        cb();
      }),
    },
    // Track registered listeners so we can fire synthetic events
    // (e.g. `exit` after kill) without waiting for the 5s graceful-
    // shutdown timeout in stopMcpServer. Without this each test would
    // pay 5s for teardown, which adds up across the suite.
    on: vi.fn((event: string, cb: (a: unknown, b: unknown) => void) => {
      if (event === 'exit') exitListeners.push(cb as never);
    }),
    kill: vi.fn(() => {
      // Defer the synthetic `exit` event so stopMcpServer can register
      // its `once('exit', ...)` handler (in real Node, kill signals are
      // also delivered asynchronously). Firing synchronously would race
      // against the `mcpProcess.on('exit', ...)` handler in mcp-client
      // that nulls out mcpProcess before stopMcpServer's `once` is
      // attached.
      queueMicrotask(() => {
        for (const listener of exitListeners) {
          listener(0, 'SIGTERM');
        }
      });
    }),
    once: vi.fn((event: string, cb: (a: unknown, b: unknown) => void) => {
      if (event === 'exit') exitListeners.push(cb as never);
    }),
    emitData: (line: string) => {
      for (const listener of dataListeners) {
        listener(Buffer.from(line));
      }
    },
  };
}

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
      const mockProcess = makeMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout, that's fine
      }

      expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(envPath);

      delete process.env.COMPUTER_USE_MCP_PATH;
      await mod.stopMcpServer();
    });

    it('falls back to binary next to process.execPath', async () => {
      delete process.env.COMPUTER_USE_MCP_PATH;
      const expectedPath = join(process.execPath, '..', 'computer-use-mcp');
      vi.mocked(existsSync).mockImplementation((p) => p === expectedPath);

      const mod = await import('./mcp-client.ts');
      const mockProcess = makeMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout
      }

      expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(expectedPath);
      await mod.stopMcpServer();
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
      const mockProcess = makeMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      try {
        await mod.startMcpServer('test-session');
      } catch {
        // May fail on initialize timeout
      }

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
      await mod.stopMcpServer();
    });
  });

  describe('isMcpServerRunning', () => {
    it('returns false initially', async () => {
      const mod = await import('./mcp-client.ts');
      expect(mod.isMcpServerRunning()).toBe(false);
    });
  });
});
