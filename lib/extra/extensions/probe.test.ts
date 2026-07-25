import { describe, expect, it } from 'vitest';
import {
  BUILTIN_EXTENSIONS,
  missingAuthEnv,
  resolveExtensions,
  resolveInvocation,
  type CliExtensionManifest,
} from './manifest';
import { probeExtension, type ProbeStatus } from './probe';

describe('resolveExtensions', () => {
  it('returns built-ins when no user config', () => {
    const list = resolveExtensions();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.map((e) => e.name)).toContain('claude-code');
  });

  it('user entry with same name replaces built-in', () => {
    const custom: CliExtensionManifest = {
      name: 'claude-code',
      cliCommand: 'my-claude-wrapper',
      authEnv: ['MY_KEY'],
    };
    const list = resolveExtensions([custom]);
    const claude = list.find((e) => e.name === 'claude-code');
    expect(claude?.cliCommand).toBe('my-claude-wrapper');
    expect(claude?.authEnv).toEqual(['MY_KEY']);
  });

  it('user entry with new name is appended', () => {
    const list = resolveExtensions([
      { name: 'gemini-cli', cliCommand: 'gemini' },
    ]);
    expect(list.map((e) => e.name)).toContain('gemini-cli');
  });
});

describe('resolveInvocation', () => {
  it('prefers cliCommand when set', () => {
    const inv = resolveInvocation({
      name: 'x',
      cliCommand: 'foo',
      defaultCliPath: 'bunx bar',
      args: ['--flag'],
    });
    expect(inv).toEqual({ command: 'foo', args: ['--flag'] });
  });

  it('falls back to defaultCliPath when cliCommand missing', () => {
    const inv = resolveInvocation({
      name: 'x',
      cliCommand: '',
      defaultCliPath: 'bunx @agentclientprotocol/claude-agent-acp',
      args: ['--acp'],
    });
    expect(inv).toEqual({
      command: 'bunx',
      args: ['@agentclientprotocol/claude-agent-acp', '--acp'],
    });
  });

  it('returns null when neither command is set', () => {
    expect(resolveInvocation({ name: 'x', cliCommand: '' })).toBeNull();
    expect(resolveInvocation({ name: 'x', cliCommand: '' })).toBeNull();
  });
});

describe('missingAuthEnv', () => {
  it('returns names absent from env', () => {
    const missing = missingAuthEnv(
      { name: 'x', cliCommand: 'x', authEnv: ['A', 'B', 'C'] },
      { A: '1' }, // B and C missing
    );
    expect(missing).toEqual(['B', 'C']);
  });

  it('empty when all present', () => {
    expect(
      missingAuthEnv(
        { name: 'x', cliCommand: 'x', authEnv: ['A'] },
        { A: '1' },
      ),
    ).toEqual([]);
  });

  it('empty when extension declares no authEnv', () => {
    expect(missingAuthEnv({ name: 'x', cliCommand: 'x' }, {})).toEqual([]);
  });
});

describe('probeExtension', () => {
  function makeSpawn(stdout: string, exitCode: number | null) {
    return async () => ({ stdout, stderr: '', exitCode });
  }

  it('status ok when --version exits 0, version is first stdout line', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x', authEnv: ['A'] },
      { A: '1' },
      makeSpawn('1.2.3\nbuild 99', 0) as never,
    );
    expect(r.status).toBe('ok');
    expect(r.version).toBe('1.2.3');
  });

  it('status missing_auth when an authEnv var is absent', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x', authEnv: ['A', 'B'] },
      { A: '1' }, // B missing
      makeSpawn('', 0) as never,
    );
    expect(r.status).toBe('missing_auth');
    expect(r.missingEnv).toEqual(['B']);
  });

  it('status not_found when invocation cannot be resolved', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: '' },
      {},
      makeSpawn('', 0) as never,
    );
    expect(r.status).toBe('not_found');
  });

  it('status non_zero_exit when --version exits non-zero', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x' },
      {},
      makeSpawn('', 2) as never,
    );
    expect(r.status).toBe('non_zero_exit');
    expect(r.exitCode).toBe(2);
  });

  it('status not_found when spawn throws ENOENT', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x' },
      {},
      (async () => {
        throw new Error('spawn x ENOENT');
      }) as never,
    );
    expect(r.status).toBe('not_found');
  });

  it('status timeout when spawn throws a timeout error', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x' },
      {},
      (async () => {
        throw new Error('command timed out');
      }) as never,
    );
    expect(r.status).toBe('timeout');
  });

  it('status error for other spawn failures', async () => {
    const r = await probeExtension(
      { name: 'x', cliCommand: 'x' },
      {},
      (async () => {
        throw new Error('something weird');
      }) as never,
    );
    expect(r.status).toBe('error');
  });

  it('BUILTIN_EXTENSIONS all resolve to a usable invocation', () => {
    // Smoke: every built-in must have either a cliCommand or a defaultCliPath
    // so resolveInvocation never returns null for them.
    for (const ext of BUILTIN_EXTENSIONS) {
      const inv = resolveInvocation(ext);
      expect(inv, `built-in ${ext.name} should resolve`).not.toBeNull();
    }
  });
});

// Type-only sanity: ProbeStatus union covers the cases the UI switches on.
const _statusCases: ProbeStatus[] = [
  'ok',
  'not_found',
  'missing_auth',
  'non_zero_exit',
  'timeout',
  'error',
];
void _statusCases;
