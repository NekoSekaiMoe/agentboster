/**
 * Backfill safe correlations from the legacy message/tool/review stores into
 * canonical Trace tables. Rows without a run/trace id are intentionally left
 * untouched: inventing a Trace ID would make future audit reconstruction
 * misleading. Every insert uses a stable legacy idempotency key so this job is
 * safe to run on every deployment during the compatibility window.
 */
import { closeRawSql, getRawQuery } from './db-raw-sql';

type TraceRun = {
  trace_id: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  started_at: string;
  status: string;
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

async function main() {
  const query = getRawQuery();
  const runRows = await query<TraceRun>(
    `SELECT trace_id,
            min(session_id::text) AS session_id,
            min(user_id) AS user_id,
            min(workspace_id::text) AS workspace_id,
            min(started_at)::text AS started_at,
            'running' AS status
       FROM (
         SELECT payload->'metadata'->>'runId' AS trace_id,
                session_id,
                s.user_id,
                s.workspace_id,
                created_at AS started_at
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
          WHERE payload->'metadata'->>'runId' IS NOT NULL
         UNION ALL
         SELECT trace_id, session_id, user_id, NULL, started_at
           FROM agent_tool_activity_logs
          WHERE trace_id IS NOT NULL
         UNION ALL
         SELECT trace_id, NULL, user_id, NULL, created_at
           FROM agent_review_logs
          WHERE trace_id IS NOT NULL
       ) correlated
      GROUP BY trace_id`,
  );

  let runs = 0;
  let spans = 0;
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
        run.status,
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
  for (const message of messages) {
    const sequence = await allocateSequence(query, message.trace_id);
    const payload = record(message.payload);
    const isTool = message.role === 'tool';
    const toolName =
      typeof payload.toolName === 'string' ? payload.toolName : 'legacy-tool';
    const toolInput = payload.toolInput ?? payload.input ?? null;
    const toolOutput = payload.toolOutput ?? payload.output ?? null;
    await query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, sequence, source, type, status,
         started_at, completed_at, duration_ms, user_id, session_id,
         workspace_id, input, output, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, 'legacy-backfill', $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (trace_id, idempotency_key) DO NOTHING`,
      [
        message.trace_id,
        `${isTool ? 'tool' : 'model'}:${message.trace_id}:${message.id}`,
        isTool ? `model:${message.trace_id}:${message.step_number ?? 0}` : null,
        sequence,
        isTool ? 'tool' : 'model',
        isTool
          ? payload.toolState === 'output-error'
            ? 'failed'
            : 'completed'
          : payload.finishReason
            ? 'completed'
            : 'running',
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
        JSON.stringify(isTool ? toolInput : null),
        JSON.stringify(isTool ? toolOutput : payload),
        JSON.stringify({
          step: message.step_number,
          role: message.role,
          toolName: isTool ? toolName : undefined,
          toolCallId: isTool ? payload.toolCallId : undefined,
          action: isTool ? 'other' : undefined,
        }),
        `backfill:${isTool ? 'tool' : 'model'}:${message.id}`,
      ],
    );
    spans += 1;
  }

  const tools = await query<ToolRow>(
    `SELECT id::text, trace_id, task_id::text, session_id::text, user_id,
            agent_id, tool_name, action, target, arguments, result,
            output_text, success, error, duration_ms,
            started_at::text, completed_at::text
       FROM agent_tool_activity_logs
      WHERE trace_id IS NOT NULL
      ORDER BY started_at, id`,
  );
  for (const tool of tools) {
    const sequence = await allocateSequence(query, tool.trace_id);
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
    spans += 1;
  }

  const reviews = await query<ReviewRow>(
    `SELECT id::text, trace_id, task_id::text, user_id, level, decision,
            score, command, reason, created_at::text
       FROM agent_review_logs
      WHERE trace_id IS NOT NULL
      ORDER BY created_at, id`,
  );
  for (const review of reviews) {
    const sequence = await allocateSequence(query, review.trace_id);
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
    spans += 1;
  }

  console.log(`[backfill-traces] runs=${runs} spans=${spans}`);
  await closeRawSql();
}

main().catch(async (error) => {
  console.error('[backfill-traces] failed:', error);
  await closeRawSql();
  process.exit(1);
});
