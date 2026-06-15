/**
 * Tests for suggested follow-up parsing and marker stripping.
 *
 * Covers:
 * - New @@FOLLOWUP_START@@/@@FOLLOWUP_END@@ marker format (single-line
 *   bracketed options, multi-line list options)
 * - Legacy "你要是愿意" format
 * - stripFollowUpMarkers fallback (complete block, partial/leftover markers,
 *   text-only without markers)
 * - Regression: markers containing underscores (the previous __ format) are
 *   no longer used; ensure the new @@ format is Markdown-safe.
 *
 * Run via: yarn test lib/chat/suggested-follow-up.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  parseSuggestedFollowUps,
  stripFollowUpMarkers,
} from './suggested-follow-up';
import {
  FOLLOWUP_MARKER_END,
  FOLLOWUP_MARKER_START,
} from './follow-up-template';

describe('parseSuggestedFollowUps', () => {
  describe('custom marker format (@@FOLLOWUP_START@@)', () => {
    it('parses single-line bracketed options (【】)', () => {
      const text = `Here is your answer.

@@FOLLOWUP_START@@
btw 我也可以【帮你写代码或调试】【帮你搜索某个问题】【陪你聊聊天】哦
@@FOLLOWUP_END@@`;
      const result = parseSuggestedFollowUps(text);
      expect(result).not.toBeNull();
      expect(result?.questions).toEqual([
        '帮你写代码或调试',
        '帮你搜索某个问题',
        '陪你聊聊天',
      ]);
      expect(result?.textWithoutQuestions).toBe('Here is your answer.');
    });

    it('parses multi-line list options', () => {
      const text = `Done.

@@FOLLOWUP_START@@
- First suggestion
- Second suggestion
- Third suggestion
@@FOLLOWUP_END@@`;
      const result = parseSuggestedFollowUps(text);
      expect(result?.questions).toEqual([
        'First suggestion',
        'Second suggestion',
        'Third suggestion',
      ]);
    });

    it('returns null when fewer than 3 options', () => {
      const text = `@@FOLLOWUP_START@@
only [one][two]
@@FOLLOWUP_END@@`;
      expect(parseSuggestedFollowUps(text)).toBeNull();
    });

    it('returns null when markers absent', () => {
      expect(parseSuggestedFollowUps('Just a normal message.')).toBeNull();
    });

    it('uses the last marker block when multiple present', () => {
      const text = `@@FOLLOWUP_START@@
[A][B][C]
@@FOLLOWUP_END@@

Some intermediate text.

@@FOLLOWUP_START@@
[X][Y][Z]
@@FOLLOWUP_END@@`;
      const result = parseSuggestedFollowUps(text);
      expect(result?.questions).toEqual(['X', 'Y', 'Z']);
    });
  });

  describe('legacy "你要是愿意" format', () => {
    it('parses the legacy block', () => {
      const text = `Answer body.

你要是愿意，我还可以继续帮你：
- 选项一
- 选项二
- 选项三`;
      const result = parseSuggestedFollowUps(text);
      expect(result?.questions).toEqual(['选项一', '选项二', '选项三']);
    });

    it('keeps the legacy header line in display text', () => {
      const text = `Body.

你要是愿意，我还可以继续帮你：
- One
- Two
- Three`;
      const result = parseSuggestedFollowUps(text);
      expect(result?.textWithoutQuestions).toContain('你要是愿意');
    });
  });
});

describe('stripFollowUpMarkers', () => {
  it('removes a complete marker block', () => {
    const text = `Body text.

@@FOLLOWUP_START@@
[A][B][C]
@@FOLLOWUP_END@@`;
    expect(stripFollowUpMarkers(text)).toBe('Body text.');
  });

  it('removes leftover bare START marker (partial streaming)', () => {
    const text = `Body text.

@@FOLLOWUP_START@@
partial content without end marker`;
    const stripped = stripFollowUpMarkers(text);
    expect(stripped).not.toContain('@@FOLLOWUP_START@@');
    expect(stripped).toContain('Body text.');
  });

  it('removes leftover bare END marker', () => {
    const text = `Body @@FOLLOWUP_END@@ more text`;
    const stripped = stripFollowUpMarkers(text);
    expect(stripped).not.toContain('@@FOLLOWUP_END@@');
  });

  it('returns original text when strip yields empty', () => {
    const text = '@@FOLLOWUP_START@@@@FOLLOWUP_END@@';
    expect(stripFollowUpMarkers(text)).toBe(text);
  });

  it('returns text unchanged when no markers present', () => {
    const text = 'Just a normal message with no markers.';
    expect(stripFollowUpMarkers(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(stripFollowUpMarkers('')).toBe('');
  });
});

describe('marker format safety', () => {
  it('uses @@ delimiters, not __ (which Markdown renders as bold/underline)', () => {
    expect(FOLLOWUP_MARKER_START).toBe('@@FOLLOWUP_START@@');
    expect(FOLLOWUP_MARKER_END).toBe('@@FOLLOWUP_END@@');
    expect(FOLLOWUP_MARKER_START).not.toContain('__');
    expect(FOLLOWUP_MARKER_END).not.toContain('__');
  });
});
