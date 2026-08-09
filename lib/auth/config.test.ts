/**
 * Tests for lib/auth/config.ts — env-driven auth configuration reader.
 *
 * Pure functions over process.env; no DB. Covers the config health-check
 * used by the UI (isConfigured / missingEnvVars) and the random env
 * example generator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateAuthEnvExample,
  getAuthConfigStatus,
  readConfiguredAuthPassword,
  readConfiguredAuthSecret,
  readConfiguredAuthUsername,
} from './config';

const ENV_KEYS = ['AUTH_SECRET', 'USERNAME', 'PASSWORD'] as const;
const originals = ENV_KEYS.map((k) => [k, process.env[k]] as const);

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of originals) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('readConfiguredAuthSecret/Username/Password', () => {
  it('returns null when the env var is unset', () => {
    expect(readConfiguredAuthSecret()).toBeNull();
    expect(readConfiguredAuthUsername()).toBeNull();
    expect(readConfiguredAuthPassword()).toBeNull();
  });

  it('returns the trimmed value when set', () => {
    process.env.AUTH_SECRET = '  sekret  ';
    process.env.USERNAME = 'alice';
    process.env.PASSWORD = 'pw';
    expect(readConfiguredAuthSecret()).toBe('sekret');
    expect(readConfiguredAuthUsername()).toBe('alice');
    expect(readConfiguredAuthPassword()).toBe('pw');
  });

  it('treats a whitespace-only value as unset', () => {
    process.env.AUTH_SECRET = '   ';
    expect(readConfiguredAuthSecret()).toBeNull();
  });
});

describe('generateAuthEnvExample', () => {
  it('emits one line per required var', () => {
    const example = generateAuthEnvExample();
    const lines = example.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^AUTH_SECRET=.+$/);
    expect(lines[1]).toMatch(/^USERNAME=.+$/);
    expect(lines[2]).toMatch(/^PASSWORD=.+$/);
  });

  it('produces different output across calls (randomness)', () => {
    const a = generateAuthEnvExample();
    const b = generateAuthEnvExample();
    expect(a).not.toBe(b);
  });

  it('uses only alphanumeric characters in generated values', () => {
    const example = generateAuthEnvExample();
    for (const line of example.split('\n')) {
      const value = line.split('=')[1];
      expect(value).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('AUTH_SECRET has 32 chars, USERNAME 12, PASSWORD 16', () => {
    const example = generateAuthEnvExample();
    const map = Object.fromEntries(
      example.split('\n').map((l) => l.split('=')),
    );
    expect(map.AUTH_SECRET).toHaveLength(32);
    expect(map.USERNAME).toHaveLength(12);
    expect(map.PASSWORD).toHaveLength(16);
  });
});

describe('getAuthConfigStatus', () => {
  it('reports unconfigured when AUTH_SECRET is missing', () => {
    const status = getAuthConfigStatus();
    expect(status.isConfigured).toBe(false);
    expect(status.missingEnvVars).toContain('AUTH_SECRET');
    expect(status.exampleEnvFile).toMatch(/AUTH_SECRET=/);
  });

  it('reports configured when AUTH_SECRET is set', () => {
    process.env.AUTH_SECRET = 'sekret';
    const status = getAuthConfigStatus();
    expect(status.isConfigured).toBe(true);
    expect(status.missingEnvVars).toEqual([]);
  });
});
