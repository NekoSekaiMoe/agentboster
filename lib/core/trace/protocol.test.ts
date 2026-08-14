import { describe, expect, it } from 'vitest';

import { normalizeTraceCallback } from './protocol';

describe('canonical Trace callback protocol', () => {
  it('normalizes the snake_case envelope without accepting caller identity', () => {
    const callback = normalizeTraceCallback({
      record_kind: 'span',
      trace_id: 'run-1',
      span_id: 'tool-1',
      parent_span_id: 'model-1',
      source: 'agentd',
      type: 'tool',
      status: 'completed',
      task_id: 'task-1',
      user_id: 'attacker-supplied',
      idempotency_key: 'tool:task-1:call-1',
      input: { path: 'README.md' },
    });

    expect(callback?.kind).toBe('span');
    expect(callback?.taskId).toBe('task-1');
    expect(callback?.envelope.userId).toBeUndefined();
    expect(callback?.envelope.idempotencyKey).toBe('tool:task-1:call-1');
  });

  it('rejects legacy payloads and incomplete canonical envelopes', () => {
    expect(
      normalizeTraceCallback({
        run_id: 'legacy-run',
        tool_name: 'read',
        task_id: 'task-1',
      }),
    ).toBeNull();
    expect(
      normalizeTraceCallback({
        record_kind: 'span',
        trace_id: 'run-1',
        span_id: 'span-1',
        type: 'tool',
      }),
    ).toBeNull();
  });
});
