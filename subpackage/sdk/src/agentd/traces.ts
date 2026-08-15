// Canonical Trace callback envelope.
//
// Source: lib/core/trace/protocol.ts
// Source: lib/core/trace/dal.ts
//
// The envelope is a discriminated union on `record_kind`. The Web
// receiver (`normalizeTraceCallback` in lib/core/trace/protocol.ts)
// enforces:
//   - `record_kind: 'event'` records MUST carry `event_id`
//   - `record_kind: 'run'` records MUST carry `span_id`
//   - `record_kind: 'span'` records require neither (span_id optional)
// Records violating the required field for their kind are rejected
// (null), so the types below mark those fields required per variant.
// `trace_id` and `idempotency_key` are required on every record.

export type TraceCallbackKind = 'run' | 'span' | 'event';
export type TraceStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'stopped';

/** Fields shared by every canonical callback record. */
export interface TraceCallbackBase {
  trace_id: string;
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

/** A `run` record: top-level trace run. Must carry its own `span_id`. */
export interface TraceRunCallback extends TraceCallbackBase {
  record_kind: 'run';
  span_id: string;
}

/** A `span` record: model step, tool call, or security review. */
export interface TraceSpanCallback extends TraceCallbackBase {
  record_kind: 'span';
  span_id?: string;
}

/** An `event` record: append-only state change inside a span. Must carry `event_id`. */
export interface TraceEventCallback extends TraceCallbackBase {
  record_kind: 'event';
  event_id: string;
  span_id?: string;
}

/**
 * Wire shape accepted by the Web agentd callback receiver.
 * Discriminated on `record_kind`; the kind determines which identity
 * fields are required (see the variant docs above).
 */
export type TraceCallbackEnvelope =
  | TraceRunCallback
  | TraceSpanCallback
  | TraceEventCallback;
