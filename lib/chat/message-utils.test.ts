/**
 * Tests for the pure data-transformation helpers in message-utils.
 *
 * message-utils is the serialization hub between the AI SDK's message
 * model and the DB / model wire formats. The whole module is large and
 * has many functions that lean on DB/AI-SDK types; this file targets the
 * pure, dependency-free helpers that are the highest regression risk:
 * truncateMiddleText (intricate marker-vs-maxChars boundary logic with
 * a re-compute pass), normalizeToolOutputForPersistence (string vs
 * object serialization + truncation), extractTextFromParts (filter +
 * join).
 */

import { describe, expect, it } from 'vitest';
import {
  TOOL_OUTPUT_MAX_CHARS,
  extractTextFromParts,
  normalizeToolOutputForPersistence,
  truncateMiddleText,
} from './message-utils';

describe('truncateMiddleText', () => {
  it('returns the input unchanged when at or under the limit', () => {
    expect(truncateMiddleText('hello', 10)).toBe('hello');
    expect(truncateMiddleText('hello', 5)).toBe('hello');
  });

  it('returns empty string when maxChars <= 0', () => {
    expect(truncateMiddleText('hello', 0)).toBe('');
    expect(truncateMiddleText('hello', -5)).toBe('');
  });

  it('truncates with a head + marker + tail when over the limit', () => {
    // Use a large maxChars so the full marker (~110 chars) fits with
    // room left over for head + tail. Otherwise the function returns
    // a bare marker slice (covered by the next test).
    const text = 'a'.repeat(800);
    const out = truncateMiddleText(text, 200);
    expect(out).toContain('omitted');
    expect(out.length).toBe(200);
    expect(out.startsWith('aaaa')).toBe(true);
    expect(out.endsWith('aaaa')).toBe(true);
  });

  it('falls back to a bare marker slice when the marker itself exceeds maxChars', () => {
    // Tiny maxChars: the marker template is longer than maxChars, so the
    // function returns the first maxChars of the marker (no head/tail).
    const out = truncateMiddleText('hello world this is long', 5);
    expect(out).toHaveLength(5);
    expect(out).toBe('...[o');
  });

  it('uses the default TOOL_OUTPUT_MAX_CHARS when maxChars is omitted', () => {
    const text = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 100);
    const out = truncateMiddleText(text);
    expect(out.length).toBe(TOOL_OUTPUT_MAX_CHARS);
    expect(out).toContain('omitted');
  });

  it('preserves a contiguous head and a contiguous tail from the original', () => {
    // maxChars (200) is large enough to fit the ~110-char marker plus
    // head + tail, so the output really has head + marker + tail.
    const text = '0123456789ABCDEF'.repeat(50); // 800 chars
    const out = truncateMiddleText(text, 200);
    expect(out.length).toBe(200);
    const markerIdx = out.indexOf('...[');
    expect(markerIdx).toBeGreaterThan(0);
    const tailMarkerClose = out.lastIndexOf(']...');
    expect(tailMarkerClose).toBeGreaterThan(markerIdx);
    const head = out.slice(0, markerIdx);
    const tail = out.slice(tailMarkerClose + 4);
    expect(text.startsWith(head)).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
  });

  it('the omitted count in the marker is the bytes NOT in head+tail', () => {
    const text = '0123456789ABCDEF'.repeat(50); // 800 chars
    const out = truncateMiddleText(text, 200);
    const match = out.match(/omitted (\d+) chars/);
    expect(match).not.toBeNull();
    const omitted = match ? Number(match[1]) : -1;
    expect(omitted).toBeGreaterThan(0);
    const markerIdx = out.indexOf('...[');
    const tailMarkerClose = out.lastIndexOf(']...') + 4;
    const headTailLen = markerIdx + (out.length - tailMarkerClose);
    // omitted + preserved head+tail == original length
    expect(omitted + headTailLen).toBe(800);
  });
});

describe('normalizeToolOutputForPersistence', () => {
  it('passes strings through (then truncates if over limit)', () => {
    expect(normalizeToolOutputForPersistence('hello', 100)).toBe('hello');
  });

  it('JSON-serializes objects with 2-space indent', () => {
    const out = normalizeToolOutputForPersistence({ a: 1, b: 'two' }, 1000);
    expect(out).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it('falls back to String(value) for non-serializable objects (circular)', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    // JSON.stringify throws on cycles → String(value) fallback.
    const out = normalizeToolOutputForPersistence(circular, 1000);
    expect(out).toBe(String(circular));
  });

  it('handles null and undefined without throwing', () => {
    // null serializes to the JSON string "null"
    expect(normalizeToolOutputForPersistence(null, 1000)).toBe('null');
    // undefined serializes via JSON.stringify to undefined → falls back
    // to String(undefined) = "undefined"
    expect(normalizeToolOutputForPersistence(undefined, 1000)).toBe(
      'undefined',
    );
  });

  it('truncates a large object via truncateMiddleText', () => {
    const big = { data: 'x'.repeat(200) };
    const out = normalizeToolOutputForPersistence(big, 40);
    expect(out.length).toBe(40);
    expect(out).toContain('omitted');
  });

  it('truncates a large string via truncateMiddleText', () => {
    const out = normalizeToolOutputForPersistence('y'.repeat(500), 30);
    expect(out.length).toBe(30);
    expect(out).toContain('omitted');
  });
});

describe('extractTextFromParts', () => {
  it('concatenates only the text-type parts', () => {
    const parts = [
      { type: 'text', text: 'hello ' },
      { type: 'tool-invocation', toolCallId: 'x' }, // ignored
      { type: 'text', text: 'world' },
    ] as never;
    expect(extractTextFromParts(parts)).toBe('hello world');
  });

  it('returns empty string when there are no text parts', () => {
    const parts = [
      { type: 'tool-invocation', toolCallId: 'x' },
      { type: 'step-start' },
    ] as never;
    expect(extractTextFromParts(parts)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(extractTextFromParts([])).toBe('');
  });

  it('trims leading/trailing whitespace from the concatenation', () => {
    const parts = [
      { type: 'text', text: '  hello  ' },
      { type: 'text', text: '  world  ' },
    ] as never;
    // inner whitespace between parts is preserved; only outer is trimmed
    expect(extractTextFromParts(parts)).toBe('hello    world');
  });
});
