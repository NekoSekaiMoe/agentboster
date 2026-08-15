import { ingestAgentdTraceCallback } from '@/lib/core/trace/receiver';
import { normalizeTraceCallback } from '@/lib/core/trace/protocol';
import type { NormalizedTraceCallback } from '@/lib/core/trace/protocol';

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
 */
export function normalizeTraceCallbackBatch(
  body: unknown,
  allowed: 'review' | 'tool',
):
  | { callbacks: NormalizedTraceCallback[]; skippedIndices: number[] }
  | { error: string } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length > TRACE_CALLBACK_BATCH_MAX) {
    return { error: 'Callback batch exceeds the allowed size' };
  }
  const callbacks: NormalizedTraceCallback[] = [];
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
    callbacks.push(normalized);
  }
  if (callbacks.length === 0) {
    return {
      error:
        allowed === 'review'
          ? 'Invalid canonical review callback'
          : 'Invalid canonical tool callback',
    };
  }
  return { callbacks, skippedIndices };
}

/**
 * Ingest callbacks with bounded concurrency and allSettled semantics.
 * - All succeed → `{ success: true, data: rows }` (unchanged success shape).
 * - Some fail → 207-style `{ success: true, partial: true, data, errors, failed }`
 *   where `data[i]` is the row or `null` and `errors[i]` is the message or `null`.
 * - All fail → `{ success: false }` (caller logs + returns 500).
 */
export async function ingestTraceCallbackBatch(
  callbacks: NormalizedTraceCallback[],
): Promise<TraceCallbackBatchOutcome> {
  const results: PromiseSettledResult<Awaited<
    ReturnType<typeof ingestAgentdTraceCallback>
  >>[] = [];
  for (
    let offset = 0;
    offset < callbacks.length;
    offset += TRACE_CALLBACK_CONCURRENCY
  ) {
    const chunk = callbacks.slice(offset, offset + TRACE_CALLBACK_CONCURRENCY);
    results.push(
      ...(await Promise.allSettled(
        chunk.map((callback) => ingestAgentdTraceCallback(callback)),
      )),
    );
  }
  const data = results.map((result) =>
    result.status === 'fulfilled' ? result.value : null,
  );
  const errors = results.map((result) =>
    result.status === 'rejected'
      ? result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)
      : null,
  );
  const failed = results.filter((result) => result.status === 'rejected')
    .length;
  if (failed === 0) {
    return { status: 200, body: { success: true, data } };
  }
  if (failed === results.length) {
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
