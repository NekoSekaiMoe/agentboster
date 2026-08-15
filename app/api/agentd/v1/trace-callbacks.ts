import { ingestAgentdTraceCallback } from '@/lib/core/trace/receiver';
import { normalizeTraceCallback } from '@/lib/core/trace/protocol';
import type { NormalizedTraceCallback } from '@/lib/core/trace/protocol';
import { createLogger } from '@/lib/utils/logger';

/** Max callbacks accepted per batch POST. Larger batches are rejected (413). */
export const TRACE_CALLBACK_BATCH_MAX = 200;

/** Max concurrent ingests per batch (batches are chunked at this size). */
export const TRACE_CALLBACK_CONCURRENCY = 25;

export type TraceCallbackBatchOutcome = {
  /** HTTP status for the whole batch: 200 all-ok, 207 partial, 500 all-failed. */
  status: number;
  body:
    | { success: true; data: unknown[] }
    | {
        success: true;
        partial: true;
        data: (unknown | null)[];
        errors: (string | null)[];
        failed: number;
      }
    | { success: false; error: string };
};

/** A validated callback plus its position in the sender's original array. */
export type IndexedTraceCallback = {
  index: number;
  callback: NormalizedTraceCallback;
};

function isValidType(type: string, allowed: 'review' | 'tool'): boolean {
  if (allowed === 'review') {
    return type.startsWith('review') || type.startsWith('security.');
  }
  return type.startsWith('tool');
}

/**
 * Normalize a request body into validated span callbacks for one log family
 * (`review` or `tool`). Invalid ITEMS are skipped (not batch-fatal): the
 * Go client already pre-filters malformed entries, but a mid-deploy mixed
 * batch must not lose its valid records. The response carries the skipped
 * item indices so senders can inspect what was dropped. An empty result
 * (everything skipped) is still an error — there is nothing to ingest.
 *
 * Each surviving callback keeps its ORIGINAL request-body index so the
 * ingest outcome stays aligned with the sender's batch (see
 * `ingestTraceCallbackBatch`). Oversized batches are a 413; invalid
 * records are a 400.
 */
export function normalizeTraceCallbackBatch(
  body: unknown,
  allowed: 'review' | 'tool',
):
  | { callbacks: IndexedTraceCallback[]; skippedIndices: number[] }
  | { error: string; status: number } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length > TRACE_CALLBACK_BATCH_MAX) {
    return {
      error: 'Callback batch exceeds the allowed size',
      status: 413,
    };
  }
  const callbacks: IndexedTraceCallback[] = [];
  const skippedIndices: number[] = [];
  for (let index = 0; index < items.length; index++) {
    const normalized = normalizeTraceCallback(items[index]);
    if (
      !normalized ||
      normalized.kind !== 'span' ||
      !isValidType(normalized.envelope.type, allowed)
    ) {
      skippedIndices.push(index);
      continue;
    }
    callbacks.push({ index, callback: normalized });
  }
  if (callbacks.length === 0) {
    return {
      error:
        allowed === 'review'
          ? 'Invalid canonical review callback'
          : 'Invalid canonical tool callback',
      status: 400,
    };
  }
  return { callbacks, skippedIndices };
}

/**
 * Ingest callbacks with bounded concurrency and allSettled semantics.
 * - All succeed → `{ success: true, data: rows }` (unchanged success shape).
 * - Some fail → 207-style `{ success: true, partial: true, data, errors, failed }`
 *   where `data[i]`/`errors[i]` are indexed by the SENDER'S ORIGINAL batch
 *   position: skipped normalization slots and failed ingests read as `null`
   * data with a `null`/message error, so failure indices always match the
 *   request body the caller sent (retries address the right records).
 * - All fail → `{ success: false }` (caller logs + returns 500).
 */
export async function ingestTraceCallbackBatch(
  indexed: IndexedTraceCallback[],
  batchSize: number,
): Promise<TraceCallbackBatchOutcome> {
  const settled = new Map<
    number,
    PromiseSettledResult<Awaited<ReturnType<typeof ingestAgentdTraceCallback>>>
  >();
  for (
    let offset = 0;
    offset < indexed.length;
    offset += TRACE_CALLBACK_CONCURRENCY
  ) {
    const chunk = indexed.slice(offset, offset + TRACE_CALLBACK_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((entry) => ingestAgentdTraceCallback(entry.callback)),
    );
    chunk.forEach((entry, i) => settled.set(entry.index, results[i]));
  }
  const data: (unknown | null)[] = [];
  const errors: (string | null)[] = [];
  let failed = 0;
  for (let index = 0; index < batchSize; index++) {
    const result = settled.get(index);
    if (result === undefined) {
      // Slot skipped during normalization — reported via skippedIndices,
      // not counted as an ingest failure.
      data.push(null);
      errors.push(null);
    } else if (result.status === 'fulfilled') {
      data.push(result.value);
      errors.push(null);
    } else {
      data.push(null);
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
      failed += 1;
    }
  }
  if (failed === 0) {
    return { status: 200, body: { success: true, data } };
  }
  if (failed === indexed.length) {
    return {
      status: 500,
      body: { success: false, error: 'All callback writes failed' },
    };
  }
  return {
    status: 207,
    body: { success: true, partial: true, data, errors, failed },
  };
}

/**
 * Shared POST-handler factory for the agentd trace-callback routes
 * (`/api/agentd/v1/review-logs` and `/api/agentd/v1/tool-activity-logs`).
 * Both routes previously duplicated this flow verbatim; the only per-route
 * variation is the allowed log family, the logger namespace and the
 * outer-catch message. Normalization errors keep their own status
 * (413 oversized batch vs 400 invalid records).
 */
export function createTraceCallbackHandler(config: {
  allowed: 'review' | 'tool';
  /** Logger namespace, e.g. `api.agentd.review-logs`. */
  scope: string;
  /** 500 message used when the route handler itself throws. */
  failureMessage: string;
}) {
  const logger = createLogger(config.scope);
  return async function POST(request: Request) {
    try {
      const requestBody = await request.json();
      const normalized = normalizeTraceCallbackBatch(requestBody, config.allowed);
      if ('error' in normalized) {
        return Response.json(
          { success: false, error: normalized.error },
          { status: normalized.status },
        );
      }
      const batchSize = Array.isArray(requestBody) ? requestBody.length : 1;
      const outcome = await ingestTraceCallbackBatch(
        normalized.callbacks,
        batchSize,
      );
      if (outcome.body.success === false) {
        logger.error('trace callback write failed', {
          error: outcome.body.error,
        });
        return Response.json(outcome.body, { status: outcome.status });
      }
      // Surface normalization skips (invalid items dropped before ingest)
      // alongside the ingest results so senders can see what was lost.
      const body =
        normalized.skippedIndices.length > 0
          ? { ...outcome.body, skippedIndices: normalized.skippedIndices }
          : outcome.body;
      return Response.json(body, { status: outcome.status });
    } catch (error) {
      logger.error('trace callback write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        { success: false, error: config.failureMessage },
        { status: 500 },
      );
    }
  };
}
