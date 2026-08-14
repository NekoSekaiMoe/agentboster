// Canonical Trace callback envelope.
//
// Source: lib/core/trace/protocol.ts
// Source: lib/core/trace/dal.ts

export type TraceCallbackKind = 'run' | 'span' | 'event';
export type TraceStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'stopped';

/** Wire shape accepted by the Web agentd callback receiver. */
export interface TraceCallbackEnvelope {
  record_kind?: TraceCallbackKind;
  trace_id: string;
  span_id?: string;
  event_id?: string;
  parent_span_id?: string;
  sequence?: number;
  source: string;
  type: string;
  status?: TraceStatus | string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  task_id?: string;
  session_id?: string;
  node_id?: string;
  agent_id?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}

