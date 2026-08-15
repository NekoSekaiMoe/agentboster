/**
 * Backfill safe correlations from the legacy message/tool/review stores into
 * canonical Trace tables. Rows without a run/trace id are intentionally left
 * untouched: inventing a Trace ID would make future audit reconstruction
 * misleading. Every insert uses a stable legacy idempotency key so this job is
 * safe to run on every deployment during the compatibility window.
 *
 * Idempotency / sequencing contract:
 * - Before allocating a sequence number for a candidate span we check whether
 *   a row with its idempotency key already exists; existing rows are skipped
 *   WITHOUT incrementing trace_runs.next_sequence (a re-run must not burn
 *   sequence slots, which would drift the canonical trace ordering).
 * - Candidates from all three legacy stores (messages, tool activity logs,
 *   review logs) are merged per trace and sorted by a stable time key
 *   (timestamp, then record id) so a canonical trace gets ONE globally
 *   consistent sequence order instead of three per-store orders.
 * - Tool rows derived from messages get parent_span_id from the ACTUAL model
 *   span id of their step (`model:${trace_id}:${message.id}`), resolved via a
 *   (trace_id, step_number) → span_id map built from the message candidates;
 *   null when no model row exists for that step (never a fabricated id).
 */
import { closeRawSql, getRawQuery } from './db-raw-sql';

type TraceRun = {
  trace_id: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  started_at: string;
  /** bool_or(has_completion) — terminal evidence for status derivation. */
  completed: boolean | null;
};
type MessageRow = {
  id: string;
  trace_id: string;
  session_id: string;
  user_id: string | null;
  workspace_id: string | null;
  role: string;
  step_number: number | null;
  payload: Record<string, unknown>;
  created_at: string;
};
type ToolRow = {
  id: string;
  trace_id: string;
  task_id: string | null;
  session_id: string | null;
  user_id: string | null;
  agent_id: string;
  tool_name: string;
  action: string;
  target: string | null;
  arguments: unknown;
  result: unknown;
  output_text: string | null;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
};
type ReviewRow = {
  id: string;
  trace_id: string;
  task_id: string;
  user_id: string | null;
  level: string;
  decision: string;
  score: number | null;
  command: string;
  reason: string | null;
  created_at: string;
};

/** One backfillable canonical span, store-agnostic. */
type SpanCandidate = {
  /** Idempotency key — existence check happens against this. */
  key: string;
  /** Stable sort key (timestamp + record id) for canonical sequencing. */
  sortAt: string;
  /** SQL columns for the trace_spans insert (order defined per type below). */
  kind: 'message-model' | 'message-tool' | 'tool-log' | 'review';
  message?: MessageRow;
  tool?: ToolRow;
  review?: ReviewRow;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function allocateSequence(
  query: ReturnType<typeof getRawQuery>,
  traceId: string,
) {
  const rows = await query<{ next_sequence: number }>(
    `UPDATE trace_runs
     SET next_sequence = next_sequence + 1, updated_at = now()
     WHERE trace_id = $1
     RETURNING next_sequence`,
    [traceId],
  );
  return Number(rows[0]?.next_sequence ?? 1);
}

async function spanExists(
  query: ReturnType<typeof getRawQuery>,
  traceId: string,
  idempotencyKey: string,
) {
  const rows = await query<{ id: string }>(
    `SELECT id FROM trace_spans
      WHERE trace_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [traceId, idempotencyKey],
  );
  return rows.length > 0;
}

async function insertSpan(
  query: ReturnType<typeof getRawQuery>,
  candidate: SpanCandidate,
  modelSpanByStep: Map<string, string>,
) {
  const sequence = await allocateSequence(
    query,
    candidate.message?.trace_id ??
      candidate.tool?.trace_id ??
      candidate.review?.trace_id ??
      '',
  );

  if (candidate.kind === 'message-model' && candidate.message) {
    const message = candidate.message;
    const payload = record(message.payload);
    await query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, sequence, source, type, status,
         started_at, completed_at, duration_ms, user_id, session_id,
         workspace_id, input, output, metadata, idempotency_key)
       VALUES ($1, $2, NULL, $3, 'legacy-backfill', 'model', $4, $5, $6, $7,
               $8, $9, $10, NULL, $11, $12, $13)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        message.trace_id,
        `model:${message.trace_id}:${message.id}`,
        sequence,
        payload.finishReason ? 'completed' : 'running',
        message.created_at,
        payload.metadata && typeof payload.metadata === 'object'
          ? ((payload.metadata as Record<string, unknown>).traceCompletedAt ??
            null)
          : null,
        payload.metadata && typeof payload.metadata === 'object'
          ? ((payload.metadata as Record<string, unknown>).traceDurationMs ??
            null)
          : null,
        message.user_id,
        message.session_id,
        message.workspace_id,
        JSON.stringify(payload),
        JSON.stringify({
          step: message.step_number,
          role: message.role,
        }),
        `backfill:model:${message.id}`,
      ],
    );
    return;
  }

  if (candidate.kind === 'message-tool' && candidate.message) {
    const message = candidate.message;
    const payload = record(message.payload);
    const toolName =
      typeof payload.toolName === 'string' ? payload.toolName : 'legacy-tool';
    const toolInput = payload.toolInput ?? payload.input ?? null;
    const toolOutput = payload.toolOutput ?? payload.output ?? null;
    // Parent = the ACTUAL model span id for this step (which embeds the
    // assistant message id, not the step number). Null when this step has
    // no model row — never a fabricated dangling id.
    const parentSpanId =
      message.step_number !== null
        ? (modelSpanByStep.get(`${message.trace_id}:${message.step_number}`) ??
          null)
        : null;
    await query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, sequence, source, type, status,
         started_at, completed_at, duration_ms, user_id, session_id,
         workspace_id, input, output, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, 'legacy-backfill', 'tool', $5, $6, $7, $8,
               $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        message.trace_id,
        `tool:${message.trace_id}:${message.id}`,
        parentSpanId,
        sequence,
        payload.toolState === 'output-error' ? 'failed' : 'completed',
        message.created_at,
        payload.metadata && typeof payload.metadata === 'object'
          ? ((payload.metadata as Record<string, unknown>).traceCompletedAt ??
            null)
          : null,
        payload.metadata && typeof payload.metadata === 'object'
          ? ((payload.metadata as Record<string, unknown>).traceDurationMs ??
            null)
          : null,
        message.user_id,
        message.session_id,
        message.workspace_id,
        JSON.stringify(toolInput),
        JSON.stringify(toolOutput),
        JSON.stringify({
          step: message.step_number,
          role: message.role,
          toolName,
          toolCallId: payload.toolCallId,
          action: 'other',
        }),
        `backfill:tool:${message.id}`,
      ],
    );
    return;
  }

  if (candidate.kind === 'tool-log' && candidate.tool) {
    const tool = candidate.tool;
    await query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, sequence, source, type, status,
         started_at, completed_at, duration_ms, user_id, session_id, task_id,
         agent_id, input, output, error, metadata, idempotency_key)
       VALUES ($1, $2, NULL, $3, 'legacy-backfill', 'tool', $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        tool.trace_id,
        `tool:${tool.id}`,
        sequence,
        tool.success ? 'completed' : 'failed',
        tool.started_at,
        tool.completed_at,
        tool.duration_ms,
        tool.user_id,
        tool.session_id,
        tool.task_id,
        tool.agent_id,
        JSON.stringify(tool.arguments),
        JSON.stringify(tool.result),
        tool.error ? JSON.stringify({ message: tool.error }) : null,
        JSON.stringify({
          toolName: tool.tool_name,
          action: tool.action,
          target: tool.target,
          outputText: tool.output_text,
        }),
        `backfill:tool:${tool.id}`,
      ],
    );
    return;
  }

  if (candidate.kind === 'review' && candidate.review) {
    const review = candidate.review;
    await query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, sequence, source, type, status,
         started_at, completed_at, duration_ms, user_id, task_id, output,
         metadata, idempotency_key)
       VALUES ($1, $2, NULL, $3, 'legacy-backfill', 'review', $4, $5, $5,
               0, $6, $7, $8, $9, $10)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        review.trace_id,
        `review:${review.id}`,
        sequence,
        review.decision.includes('blocked') ||
        review.decision.includes('rejected')
          ? 'failed'
          : review.decision.includes('pending')
            ? 'pending'
            : 'completed',
        review.created_at,
        review.user_id,
        review.task_id,
        JSON.stringify({ decision: review.decision, score: review.score }),
        JSON.stringify({
          level: review.level,
          decision: review.decision,
          score: review.score,
          command: review.command,
          reason: review.reason,
        }),
        `backfill:review:${review.id}`,
      ],
    );
  }
}

async function main() {
  const query = getRawQuery();
  const runRows = await query<TraceRun>(
    `SELECT trace_id,
            min(session_id::text) AS session_id,
            min(user_id) AS user_id,
            min(workspace_id::text) AS workspace_id,
            min(started_at)::text AS started_at,
            bool_or(has_completion) AS completed
       FROM (
         SELECT payload->'metadata'->>'runId' AS trace_id,
                session_id,
                s.user_id,
                s.workspace_id,
                created_at AS started_at,
                (m.role = 'assistant'
                 AND (m.payload->>'finishReason') IS NOT NULL) AS has_completion
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
          WHERE payload->'metadata'->>'runId' IS NOT NULL
         UNION ALL
         SELECT trace_id, session_id, user_id, NULL, started_at, NULL
           FROM agent_tool_activity_logs
          WHERE trace_id IS NOT NULL
         UNION ALL
         SELECT trace_id, NULL, user_id, NULL, created_at, NULL
           FROM agent_review_logs
          WHERE trace_id IS NOT NULL
       ) correlated
      GROUP BY trace_id`,
  );

  let runs = 0;
  let spans = 0;
  let skipped = 0;
  for (const run of runRows) {
    await query(
      `INSERT INTO trace_runs
        (trace_id, span_id, sequence, source, status, started_at, user_id,
         session_id, workspace_id, idempotency_key, next_sequence)
       VALUES ($1, $2, 0, 'legacy-backfill', $3, $4, $5, $6, $7, $8, 0)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        run.trace_id,
        `run:${run.trace_id}`,
        // Derive from completion evidence: legacy runs are historical, so
        // 'running' would be a lie that keeps the UI spin forever. When no
        // terminal evidence exists, 'unknown' is safe: query.ts's
        // canonicalStatus passes it through and aggregate.ts's hintStatus
        // falls through to event-derived status (also 'unknown'), which the
        // UI renders as an inconclusive state — not a live run.
        run.completed ? 'completed' : 'unknown',
        run.started_at,
        run.user_id,
        run.session_id,
        run.workspace_id,
        `backfill:run:${run.trace_id}`,
      ],
    );
    runs += 1;
  }

  const messages = await query<MessageRow>(
    `SELECT m.id,
            m.payload->'metadata'->>'runId' AS trace_id,
            m.session_id::text AS session_id,
            s.user_id,
            s.workspace_id::text AS workspace_id,
            m.role,
            m.step_number,
            m.payload,
            m.created_at::text AS created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
      WHERE m.payload->'metadata'->>'runId' IS NOT NULL
        AND m.role IN ('assistant', 'tool')
      ORDER BY m.created_at, m.id`,
  );
  const tools = await query<ToolRow>(
    `SELECT id::text, trace_id, task_id::text, session_id::text, user_id,
            agent_id, tool_name, action, target, arguments, result,
            output_text, success, error, duration_ms,
            started_at::text, completed_at::text
       FROM agent_tool_activity_logs
      WHERE trace_id IS NOT NULL
      ORDER BY started_at, id`,
  );
  const reviews = await query<ReviewRow>(
    `SELECT id::text, trace_id, task_id::text, user_id, level, decision,
            score, command, reason, created_at::text
       FROM agent_review_logs
      WHERE trace_id IS NOT NULL
      ORDER BY created_at, id`,
  );

  // Map (trace_id, step_number) → actual model span id, so tool rows parent
  // to the real `model:${trace_id}:${message.id}` span id instead of the
  // fabricated `model:${trace_id}:${step}` id that never exists.
  const modelSpanByStep = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.step_number !== null) {
      modelSpanByStep.set(
        `${message.trace_id}:${message.step_number}`,
        `model:${message.trace_id}:${message.id}`,
      );
    }
  }

  // Merge all candidates and order them globally by stable time key so the
  // canonical trace sequence is consistent across stores.
  const candidates: SpanCandidate[] = [
    ...messages.map((message) => ({
      key: `backfill:${message.role === 'tool' ? 'tool' : 'model'}:${message.id}`,
      sortAt: message.created_at,
      kind: (message.role === 'tool' ? 'message-tool' : 'message-model') as
        | 'message-tool'
        | 'message-model',
      message,
    })),
    ...tools.map((tool) => ({
      key: `backfill:tool:${tool.id}`,
      sortAt: tool.started_at,
      kind: 'tool-log' as const,
      tool,
    })),
    ...reviews.map((review) => ({
      key: `backfill:review:${review.id}`,
      sortAt: review.created_at,
      kind: 'review' as const,
      review,
    })),
  ].sort((a, b) =>
    a.sortAt === b.sortAt
      ? a.key.localeCompare(b.key)
      : a.sortAt < b.sortAt
        ? -1
        : 1,
  );

  for (const candidate of candidates) {
    const traceId =
      candidate.message?.trace_id ??
      candidate.tool?.trace_id ??
      candidate.review?.trace_id ??
      '';
    // Skip candidates that already have a span (idempotent re-run) WITHOUT
    // consuming a sequence slot.
    if (await spanExists(query, traceId, candidate.key)) {
      skipped += 1;
      continue;
    }
    await insertSpan(query, candidate, modelSpanByStep);
    spans += 1;
  }

  console.log(
    `[backfill-traces] runs=${runs} spans=${spans} skipped=${skipped}`,
  );
  await closeRawSql();
}

main().catch(async (error) => {
  console.error('[backfill-traces] failed:', error);
  await closeRawSql();
  process.exit(1);
});
