import { describe, expect, it } from 'vitest';
import {
  buildSpillReplacement,
  clampFetchWindow,
  DEFAULT_SPILL_PREVIEW_CHARS,
  resolveSpillSettings,
  serializeForSpill,
  spillKey,
} from './core';

describe('resolveSpillSettings', () => {
  it('returns defaults without env', () => {
    const s = resolveSpillSettings({});
    expect(s.disabled).toBe(false);
    expect(s.thresholdChars).toBe(50_000);
    expect(s.previewChars).toBe(DEFAULT_SPILL_PREVIEW_CHARS);
  });

  it('accepts env overrides and rejects invalid values', () => {
    const s = resolveSpillSettings({
      AGENT_TOOL_SPILL_THRESHOLD_CHARS: '1000',
      AGENT_TOOL_SPILL_TTL_SECONDS: '120',
      AGENT_TOOL_SPILL_MAX_STORE_CHARS: '2000',
    });
    expect(s).toMatchObject({
      thresholdChars: 1000,
      ttlSeconds: 120,
      maxStoreChars: 2000,
    });
    expect(
      resolveSpillSettings({ AGENT_TOOL_SPILL_THRESHOLD_CHARS: 'abc' })
        .thresholdChars,
    ).toBe(50_000);
  });

  it('honors the disable switch', () => {
    expect(
      resolveSpillSettings({ AGENT_TOOL_SPILL_DISABLED: '1' }).disabled,
    ).toBe(true);
    expect(
      resolveSpillSettings({ AGENT_TOOL_SPILL_DISABLED: 'true' }).disabled,
    ).toBe(true);
    expect(
      resolveSpillSettings({ AGENT_TOOL_SPILL_DISABLED: '0' }).disabled,
    ).toBe(false);
  });
});

describe('serializeForSpill', () => {
  it('passes strings through unchanged', () => {
    expect(serializeForSpill('raw')).toBe('raw');
  });

  it('pretty-prints JSON values', () => {
    expect(serializeForSpill({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('falls back to String() for non-serializable values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof serializeForSpill(cyclic)).toBe('string');
  });
});

describe('buildSpillReplacement', () => {
  const settings = resolveSpillSettings({});

  it('builds a locator with preview and retrieval hint', () => {
    const text = 'x'.repeat(60_000);
    const r = buildSpillReplacement({
      spillId: 'call-1',
      text,
      settings,
    });
    expect(r.spilled).toBe(true);
    expect(r.spillId).toBe('call-1');
    expect(r.totalChars).toBe(60_000);
    expect(r.storedChars).toBe(60_000);
    expect(r.truncatedInStore).toBe(false);
    expect(r.preview).toBe('x'.repeat(settings.previewChars));
    expect(r.note).toContain('fetch_spilled_output');
    expect(r.note).toContain('call-1');
    expect(r.note).toContain(`"offset":${settings.previewChars}`);
  });

  it('marks storage truncation when the text exceeds the store cap', () => {
    const huge = 'y'.repeat(settings.maxStoreChars + 5);
    const r = buildSpillReplacement({
      spillId: 'call-2',
      text: huge,
      settings,
    });
    expect(r.storedChars).toBe(settings.maxStoreChars);
    expect(r.truncatedInStore).toBe(true);
    expect(r.note).toContain('retained in storage');
  });
});

describe('clampFetchWindow', () => {
  it('clamps offset and length into bounds', () => {
    expect(
      clampFetchWindow({ offset: -5, length: 999_999, totalChars: 100 }),
    ).toEqual({ offset: 0, length: 20_000 });
    expect(
      clampFetchWindow({ offset: 90, length: 5000, totalChars: 100 }),
    ).toEqual({ offset: 90, length: 5000 });
  });

  it('offset never exceeds totalChars (empty page at the end)', () => {
    expect(
      clampFetchWindow({ offset: 500, length: 100, totalChars: 100 }),
    ).toEqual({ offset: 100, length: 100 });
  });
});

describe('spillKey', () => {
  it('namespaces the key', () => {
    expect(spillKey('call-1')).toBe('tool-spill:v1:call-1');
  });
});
