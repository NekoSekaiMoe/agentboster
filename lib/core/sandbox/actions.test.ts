/**
 * Tests for the sandbox cwd normalizer.
 *
 * The Vercel Sandbox's nominal user home (`/home/sbx_userXXX`) does NOT
 * exist on disk — the only persistent directory is
 * `/vercel/sandbox/workspace`. When the LLM picks up the sandbox
 * username from `whoami` / `id` output and passes it as cwd, the
 * sandbox API fails at process start with
 *   `chdir /home/sbx_user1051: no such file or directory`
 * (HTTP 400, `command_failed`). normalizeCwd is the guard that
 * rewrites such paths back to the workspace root.
 *
 * Run via: yarn test lib/core/sandbox/actions.test.ts
 */

import { describe, expect, it } from 'vitest';
import { normalizeCwd } from './actions';
import { SANDBOX_WORKSPACE_DIR } from './runtime';

describe('normalizeCwd', () => {
  it('returns the workspace root when cwd is undefined / empty', () => {
    expect(normalizeCwd(undefined)).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('')).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it('resolves relative paths against the workspace root', () => {
    expect(normalizeCwd('projects/foo')).toBe(
      `${SANDBOX_WORKSPACE_DIR}/projects/foo`,
    );
    expect(normalizeCwd('a/b/c')).toBe(`${SANDBOX_WORKSPACE_DIR}/a/b/c`);
  });

  it('accepts the workspace root itself', () => {
    expect(normalizeCwd(SANDBOX_WORKSPACE_DIR)).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it('accepts paths nested under the workspace', () => {
    expect(normalizeCwd(`${SANDBOX_WORKSPACE_DIR}/projects`)).toBe(
      `${SANDBOX_WORKSPACE_DIR}/projects`,
    );
    expect(
      normalizeCwd(`${SANDBOX_WORKSPACE_DIR}/.local/bin/deep/nested`),
    ).toBe(`${SANDBOX_WORKSPACE_DIR}/.local/bin/deep/nested`);
  });

  it('accepts the system allowlist (/, /tmp)', () => {
    expect(normalizeCwd('/')).toBe('/');
    expect(normalizeCwd('/tmp')).toBe('/tmp');
    // Trailing-slash variants are normalized.
    expect(normalizeCwd('//')).toBe('/');
    expect(normalizeCwd('/tmp/')).toBe('/tmp');
  });

  it('REWRITES the LLM-inferred /home/sbx_userXXX path (regression guard)', () => {
    // This is the exact failure mode from the production error log:
    //   chdir /home/sbx_user1051: no such file or directory
    // The LLM derived the username from `whoami` and tried to use it
    // as cwd. normalizeCwd must rewrite it back to the workspace root.
    expect(normalizeCwd('/home/sbx_user1051')).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('/home/sbx_user1')).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('/home/sandbox')).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it('rewrites other non-existent / arbitrary absolute paths', () => {
    // We can't enumerate every "doesn't exist" path, so the rule is
    // "outside workspace AND not on the system allowlist → fallback".
    expect(normalizeCwd('/root')).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('/nonexistent')).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('/etc')).toBe(SANDBOX_WORKSPACE_DIR);
    expect(normalizeCwd('/var/log')).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it('does not match the workspace by prefix alone (path-segment aware)', () => {
    // /vercel/sandbox/workspace-evil must NOT be treated as inside the
    // workspace — the prefix check has to be segment-aware (`/` suffix
    // or exact match), not a naive startsWith.
    expect(normalizeCwd('/vercel/sandbox/workspace-evil')).toBe(
      SANDBOX_WORKSPACE_DIR,
    );
    expect(normalizeCwd('/vercel/sandbox/workspace-similar')).toBe(
      SANDBOX_WORKSPACE_DIR,
    );
  });

  it('preserves ./ and ../ relative segments in workspace-relative paths', () => {
    // The current implementation joins verbatim; it does not collapse
    // ../ segments. This test pins that behavior so future changes to
    // resolveSandboxPath are deliberate, not accidental.
    expect(normalizeCwd('./foo')).toBe(`${SANDBOX_WORKSPACE_DIR}/./foo`);
    expect(normalizeCwd('../escape')).toBe(
      `${SANDBOX_WORKSPACE_DIR}/../escape`,
    );
  });
});
