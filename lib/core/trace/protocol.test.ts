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

  it('ignores a client-supplied sequence: ordering is server-allocated', () => {
    const callback = normalizeTraceCallback({
      record_kind: 'span',
      trace_id: 'run-seq',
      span_id: 'span-1',
      type: 'tool',
      status: 'completed',
      // Attacker/producer-supplied sequence must never reach the envelope;
      // the server allocates sequence via allocateSequence() at ingest time.
      sequence: 99999,
      idempotency_key: 'tool:run-seq:call-1',
    });

    expect(callback?.envelope).toBeDefined();
    const envelope = callback?.envelope as Record<string, unknown> | undefined;
    expect(envelope?.sequence).toBeUndefined();
  });

  it('adapts legacy agentd payloads without creating a second storage path', () => {
    const callback = normalizeTraceCallback({
      run_id: 'legacy-run',
      tool_name: 'read',
      action: 'read',
      task_id: 'task-1',
      success: true,
    });
    expect(callback?.envelope.traceId).toBe('legacy-run');
    expect(callback?.envelope.type).toBe('tool');
    expect(callback?.envelope.metadata).toMatchObject({ toolName: 'read' });
    expect(callback?.envelope.spanId).toMatch(/^tool:/);
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
