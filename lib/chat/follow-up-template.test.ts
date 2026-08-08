/**
 * Tests for the follow-up template parser/renderer.
 *
 * Pure regex-based parsing of a ```followup fenced block, with
 * {0}/{1}/{2} placeholder validation. No IO. Regression focus:
 * missing block, missing title/format, missing placeholders, and the
 * rendered instruction shape that the model is told to emit.
 */

import { describe, expect, it } from 'vitest';
import {
  FOLLOWUP_MARKER_END,
  FOLLOWUP_MARKER_START,
  LEGACY_FOLLOWUP_MARKER,
  parseFollowUpTemplate,
  renderFollowUpInstruction,
  type FollowUpTemplate,
} from './follow-up-template';

describe('constants', () => {
  it('exposes the marker pair and legacy marker', () => {
    expect(FOLLOWUP_MARKER_START).toMatch(/^@@FOLLOWUP_START@@$/);
    expect(FOLLOWUP_MARKER_END).toMatch(/^@@FOLLOWUP_END@@$/);
    expect(LEGACY_FOLLOWUP_MARKER).toBe('你要是愿意');
  });
});

describe('parseFollowUpTemplate', () => {
  it('parses a well-formed block with title + format + all placeholders', () => {
    const soul = [
      'Some soul preamble.',
      '```followup',
      'title: 推荐下一步',
      'format: [{0}] [{1}] [{2}]',
      '```',
      'trailing text',
    ].join('\n');
    expect(parseFollowUpTemplate(soul)).toEqual({
      title: '推荐下一步',
      format: '[{0}] [{1}] [{2}]',
    });
  });

  it('returns null for an empty / null-ish input', () => {
    expect(parseFollowUpTemplate('')).toBeNull();
  });

  it('returns null when there is no followup fenced block', () => {
    expect(parseFollowUpTemplate('no block here at all')).toBeNull();
  });

  it('returns null when the block is missing the title line', () => {
    const soul = ['```followup', 'format: [{0}] [{1}] [{2}]', '```'].join('\n');
    expect(parseFollowUpTemplate(soul)).toBeNull();
  });

  it('returns null when the block is missing the format line', () => {
    const soul = ['```followup', 'title: t', '```'].join('\n');
    expect(parseFollowUpTemplate(soul)).toBeNull();
  });

  it('returns null when the format is missing one of {0}/{1}/{2}', () => {
    expect(
      parseFollowUpTemplate(
        ['```followup', 'title: t', 'format: [{0}] [{1}]', '```'].join('\n'),
      ),
    ).toBeNull();
    expect(
      parseFollowUpTemplate(
        ['```followup', 'title: t', 'format: [{0}] [{2}]', '```'].join('\n'),
      ),
    ).toBeNull();
    expect(
      parseFollowUpTemplate(
        ['```followup', 'title: t', 'format: [{1}] [{2}]', '```'].join('\n'),
      ),
    ).toBeNull();
  });

  it('accepts placeholders in any order and reused (only presence matters)', () => {
    const soul = [
      '```followup',
      'title: t',
      'format: {2} then {0} then {1} then {0}',
      '```',
    ].join('\n');
    expect(parseFollowUpTemplate(soul)).not.toBeNull();
  });

  it('trims whitespace around title and format values', () => {
    const soul = [
      '```followup',
      'title:    spaced title   ',
      'format:    {0} {1} {2}   ',
      '```',
    ].join('\n');
    expect(parseFollowUpTemplate(soul)).toEqual({
      title: 'spaced title',
      format: '{0} {1} {2}',
    });
  });

  it('only parses the FIRST followup block when multiple exist', () => {
    const soul = [
      '```followup',
      'title: first',
      'format: {0} {1} {2}',
      '```',
      '```followup',
      'title: second',
      'format: {0} {1} {2}',
      '```',
    ].join('\n');
    expect(parseFollowUpTemplate(soul)?.title).toBe('first');
  });
});

describe('renderFollowUpInstruction', () => {
  const template: FollowUpTemplate = {
    title: 'Next steps',
    format: '[{0}] [{1}] [{2}]',
  };

  it('returns a non-empty array of instruction lines', () => {
    const lines = renderFollowUpInstruction(template);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.some((l) => l.includes('Next steps'))).toBe(true);
  });

  it('includes the start and end markers verbatim', () => {
    const lines = renderFollowUpInstruction(template);
    expect(lines).toContain(FOLLOWUP_MARKER_START);
    expect(lines).toContain(FOLLOWUP_MARKER_END);
  });

  it('includes the raw template format for the model to substitute', () => {
    const lines = renderFollowUpInstruction(template);
    expect(lines.some((l) => l.includes('[{0}] [{1}] [{2}]'))).toBe(true);
  });

  it('includes a sample with all three placeholders substituted', () => {
    const lines = renderFollowUpInstruction(template);
    const sample = lines.find(
      (l) =>
        l.includes('<a concise follow-up option>') &&
        l.includes('<a concise follow-up option>'),
    );
    expect(sample).toBeDefined();
    // Three substitutions on a single-line format
    const matches = sample
      ? sample.match(/<a concise follow-up option>/g)
      : null;
    expect(matches).toHaveLength(3);
  });
});
