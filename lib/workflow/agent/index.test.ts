/**
 * Tests for the structured terminal-status classification in the chat
 * workflow's error path (W3 fix).
 *
 * Previously the finalizer regex-matched the error MESSAGE for
 * /timeout/i and /cancel/i, so a provider error reading e.g.
 * "upstream request timeout while calling tool" or "user asked to cancel
 * the subscription update" would misclassify a genuine failure as
 * 'timeout'/'stopped'. Classification must now rely on structural
 * signals only (error name / code / cause.code / typed signal classes).
 *
 * Run via: yarn test lib/workflow/agent/index.test.ts
 */

import { describe, expect, it } from 'vitest';

// Import only the pure classifier; the surrounding module imports the
// workflow SDK, which the vitest node environment resolves fine (it is a
// plain npm package, mocked away elsewhere in the suite when needed).
import { classifyTerminalStatus } from './index';

describe('classifyTerminalStatus', () => {
  it('classifies provider/tool errors containing "timeout" text as error', () => {
    expect(
      classifyTerminalStatus(new Error('upstream request timeout (504)')),
    ).toBe('error');
  });

  it('classifies provider/tool errors containing "cancel" text as error', () => {
    expect(
      classifyTerminalStatus(new Error('user asked to cancel subscription')),
    ).toBe('error');
  });

  it('classifies generic errors as error', () => {
    expect(classifyTerminalStatus(new Error('boom'))).toBe('error');
    expect(classifyTerminalStatus('a plain string throw')).toBe('error');
    expect(classifyTerminalError()).toBe('error');
  });

  it('classifies a TimeoutError name as timeout', () => {
    const err = new Error('operation exceeded deadline');
    err.name = 'TimeoutError';
    expect(classifyTerminalStatus(err)).toBe('timeout');
  });

  it('classifies code TIMEOUT as timeout', () => {
    const err = Object.assign(new Error('deadline exceeded'), {
      code: 'TIMEOUT',
    });
    expect(classifyTerminalStatus(err)).toBe('timeout');
  });

  it('classifies cause.code TimeoutError as timeout', () => {
    const err = Object.assign(
      new Error('workflow run failed', {
        cause: Object.assign(new Error('inner'), { code: 'TimeoutError' }),
      }),
    );
    expect(classifyTerminalStatus(err)).toBe('timeout');
  });

  it('classifies AbortError as stopped', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyTerminalStatus(err)).toBe('stopped');
  });
});

function classifyTerminalError(): 'timeout' | 'stopped' | 'error' {
  return classifyTerminalStatus(undefined);
}
