/**
 * Tool-result spill — pure core.
 *
 * Adapted from DeepSeek Harness's `spill` capability family
 * (`packages/spill/`, see ref/deepseek-harness): when a tool result is too
 * large for the model context, the full text is stored server-side and the
 * model-visible result is replaced by a bounded preview plus a *locator and
 * retrieval hint* — destructive middle-truncation loses the middle forever;
 * spill keeps it addressable.
 *
 * This module is pure (no Node/Next/DB imports) so it can be unit-tested
 * directly and stay inside the workflow bundle constraints.
 */

/** Default spill threshold — matches TOOL_OUTPUT_MAX_CHARS in
 *  lib/chat/message-utils.ts, the point where persistence truncates. */
export const DEFAULT_SPILL_THRESHOLD_CHARS = 50_000;

/** Head preview kept in the model-visible replacement. */
export const DEFAULT_SPILL_PREVIEW_CHARS = 4_000;

/**
 * Cap on what is actually stored in the KV backend, protecting Upstash's
 * per-entry byte limit (escaped JSON can inflate ~2x; 500k chars stays
 * comfortably under 1MB across backends).
 */
export const DEFAULT_SPILL_MAX_STORE_CHARS = 500_000;

/** Spill entries expire after a week — old tool output has little value. */
export const DEFAULT_SPILL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Max page size the fetch tool will return (bounded so the fetch tool's own
 *  output can never trigger another spill). */
export const SPILL_FETCH_MAX_LENGTH = 20_000;

export function spillKey(spillId: string): string {
  return `tool-spill:v1:${spillId}`;
}

export interface SpillEnvOptions extends Record<string, string | undefined> {
  AGENT_TOOL_SPILL_THRESHOLD_CHARS?: string | undefined;
  AGENT_TOOL_SPILL_TTL_SECONDS?: string | undefined;
  AGENT_TOOL_SPILL_MAX_STORE_CHARS?: string | undefined;
  AGENT_TOOL_SPILL_DISABLED?: string | undefined;
}

export interface SpillSettings {
  thresholdChars: number;
  ttlSeconds: number;
  maxStoreChars: number;
  previewChars: number;
  disabled: boolean;
}

function parseIntOr(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

export function resolveSpillSettings(
  env: Record<string, string | undefined> = process.env,
): SpillSettings {
  const disabledFlag = env.AGENT_TOOL_SPILL_DISABLED?.trim();
  return {
    thresholdChars: parseIntOr(
      env.AGENT_TOOL_SPILL_THRESHOLD_CHARS,
      DEFAULT_SPILL_THRESHOLD_CHARS,
      1000,
    ),
    ttlSeconds: parseIntOr(
      env.AGENT_TOOL_SPILL_TTL_SECONDS,
      DEFAULT_SPILL_TTL_SECONDS,
      60,
    ),
    maxStoreChars: parseIntOr(
      env.AGENT_TOOL_SPILL_MAX_STORE_CHARS,
      DEFAULT_SPILL_MAX_STORE_CHARS,
      1000,
    ),
    previewChars: DEFAULT_SPILL_PREVIEW_CHARS,
    disabled: disabledFlag === '1' || disabledFlag?.toLowerCase() === 'true',
  };
}

/**
 * Serialize a tool result the same way persistence does (JSON pretty-print,
 * with a String() fallback for non-serializable values) — WITHOUT
 * truncation. The spill decision is made on this exact serialized form.
 */
export function serializeForSpill(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

/** The model-visible replacement for a spilled result. */
export interface SpilledToolResult {
  spilled: true;
  spillId: string;
  totalChars: number;
  /** How much of the text was actually stored (may be < totalChars). */
  storedChars: number;
  truncatedInStore: boolean;
  /** Head preview of the full output. */
  preview: string;
  /** Model-facing locator + retrieval instruction. */
  note: string;
}

export function buildSpillReplacement(input: {
  spillId: string;
  text: string;
  settings: SpillSettings;
}): SpilledToolResult {
  const { spillId, text, settings } = input;
  const totalChars = text.length;
  const storedText = text.slice(0, settings.maxStoreChars);
  const truncatedInStore = totalChars > storedText.length;
  const storedChars = storedText.length;
  const preview = text.slice(0, settings.previewChars);
  const truncationNote = truncatedInStore
    ? ` (only the first ${storedChars.toLocaleString('en-US')} of ${totalChars.toLocaleString('en-US')} chars were retained in storage)`
    : '';
  const note =
    `Tool output was ${totalChars.toLocaleString('en-US')} chars — too large for the conversation context.` +
    ` The full output${truncationNote} is stored under spill id "${spillId}"` +
    ` and expires in about ${Math.round(settings.ttlSeconds / 86400)} day(s).` +
    ` Call the fetch_spilled_output tool with {"spillId":"${spillId}","offset":${settings.previewChars},"length":4000}` +
    ` to page through it (offset 0 repeats the preview).`;

  return {
    spilled: true,
    spillId,
    totalChars,
    storedChars,
    truncatedInStore,
    preview,
    note,
  };
}

/** Stored record shape (KV value). */
export interface StoredSpill {
  text: string;
  totalChars: number;
  toolName?: string;
  createdAt: string;
}

/** Validate + clamp a fetch window. Pure; used by the fetch tool. */
export function clampFetchWindow(input: {
  offset: number;
  length: number;
  totalChars: number;
}): { offset: number; length: number } {
  const offset = Number.isFinite(input.offset)
    ? Math.max(0, Math.min(Math.floor(input.offset), input.totalChars))
    : 0;
  const length = Number.isFinite(input.length)
    ? Math.max(1, Math.min(Math.floor(input.length), SPILL_FETCH_MAX_LENGTH))
    : DEFAULT_SPILL_PREVIEW_CHARS;
  return { offset, length };
}
