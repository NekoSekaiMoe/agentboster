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
//
// `sequence` is intentionally NOT part of the wire contract: the server
// allocates the canonical ordering key itself (allocateSequence in
// lib/core/trace/dal.ts) inside the ingest transaction, and
// normalizeTraceCallback ignores any client-supplied sequence field.

// Source: lib/core/trace/protocol.ts:3
export type TraceCallbackKind = 'run' | 'span' | 'event';

// Source: lib/core/trace/dal.ts:20
export type TraceStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'stopped';

/** Fields shared by every canonical callback record. */
// Source: lib/core/trace/dal.ts:29 (TraceEnvelopeBase)
// Source: lib/core/trace/protocol.ts:28 (normalizeTraceCallback — ignored fields omitted)
export interface TraceCallbackBase {
  trace_id: string;
  parent_span_id?: string;
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
// Source: lib/core/trace/dal.ts:53 (TraceRunInput)
// Source: lib/core/trace/protocol.ts:74-76 (run records require span_id)
export interface TraceRunCallback extends TraceCallbackBase {
  record_kind: 'run';
  span_id: string;
}

/** A `span` record: model step, tool call, or security review. */
// Source: lib/core/trace/dal.ts:58 (TraceSpanInput)
// Source: lib/core/trace/protocol.ts:67-76 (span records: span_id optional)
export interface TraceSpanCallback extends TraceCallbackBase {
  record_kind: 'span';
  span_id?: string;
}

/** An `event` record: append-only state change inside a span. Must carry `event_id`. */
// Source: lib/core/trace/dal.ts:59 (TraceEventInput)
// Source: lib/core/trace/protocol.ts:67-73 (event records require event_id)
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
// Source: lib/core/trace/protocol.ts:5-11 (NormalizedTraceCallback kind/envelope union)
export type TraceCallbackEnvelope =
  | TraceRunCallback
  | TraceSpanCallback
  | TraceEventCallback;
