/**
 * Large-payload sanitization for tool activity logs.
 *
 * Borrowed from AionCore
 * (`crates/aionui-ai-agent/src/protocol/events/translate.rs`,
 * `sanitize_inline_image_result`): AionCore detects when a third-party agent
 * (codex / claude code) returns a tool result whose `result` field is a
 * multi-MB base64 image, and strips it before the payload reaches SQLite or
 * the WebSocket broadcast — keeping only `saved_path` and adding
 * `result_omitted: true`. We generalize the same idea here for AgentBoster's
 * `agent_tool_activity_logs` table, which receives every tool call's
 * arguments/result/outputText/error and would otherwise bloat Postgres with
 * raw screenshots, file dumps, and command stdout.
 *
 * Behavior:
 *
 *   - Any string value that exceeds `textByteThreshold` (default 64 KiB,
 *     matching AionCore's `ACP_RAW_OUTPUT_INLINE_IMAGE_LIMIT`) is uploaded to
 *     Blob storage and replaced in-place by a reference marker:
 *
 *         { "__blob_ref__": "<url>", "__omitted__": true,
 *           "__omitted_reason__": "oversized_text",
 *           "__bytes__": <original-byte-length> }
 *
 *   - Strings that look like inline base64 images are offloaded at a much
 *     smaller threshold (`imageBase64Threshold`, default 8 KiB) because they
 *     encode binary with no information loss and disproportionately inflate
 *     JSON columns.
 *
 *   - Object and array payloads are walked recursively; only string leaves are
 *     ever replaced, so the surrounding structure (field names, sibling small
 *     values) is preserved for querying/display.
 *
 *   - When Blob storage is unreachable the value is *truncated in place*
 *     (never dropped silently) with a `__truncated__` marker, so the DB row is
 *     always safe to insert regardless of blob backend availability.
 *
 * The marker shape is intentionally namespaced (`__*__`) so UIs and the agent
 * loop can detect "this field was offloaded" and render a fetch link instead
 * of trusting the value verbatim.
 */
import { put, type BlobAccess } from '@/lib/core/blob';

const logger = createLazyLogger('blob.sanitize');

export interface SanitizeOptions {
  /**
   * Strings longer than this (UTF-8 bytes) are offloaded to Blob. Default
   * 64 KiB, matching AionCore's `ACP_RAW_OUTPUT_INLINE_IMAGE_LIMIT`.
   */
  textByteThreshold?: number;
  /**
   * Strings that parse as inline base64 images are offloaded at this smaller
   * threshold. Default 8 KiB — base64 images carry no lossy info and bloat
   * JSON columns ~1.37×.
   */
  imageBase64Threshold?: number;
  /**
   * Cap applied when Blob upload fails — the value is hard-truncated to this
   * many bytes (with a marker appended) so the row is still insertable.
   * Default 4 KiB.
   */
  fallbackTruncateBytes?: number;
  /** Blob access level for offloaded payloads. Defaults to configured. */
  access?: BlobAccess;
  /**
   * Pathname prefix for offloaded blobs. Caller may pass a per-session / per-
   * task prefix to keep blob storage tidy.
   */
  pathnamePrefix?: string;
}

export const DEFAULT_SANITIZE_OPTIONS = {
  textByteThreshold: 64 * 1024,
  imageBase64Threshold: 8 * 1024,
  fallbackTruncateBytes: 4 * 1024,
  pathnamePrefix: 'tool-activity',
} as const;

/** Marker shape substituted in place of an offloaded string value. */
export interface BlobRefMarker {
  /** Always the literal string 'blob_ref' — runtime sentinel. */
  __blob_ref__: string;
  __omitted__: true;
  __omitted_reason__: 'oversized_text' | 'inline_image_base64';
  __bytes__: number;
  __mime_type__?: string;
}

/** Marker shape substituted when Blob upload failed and we truncated instead. */
export interface TruncationMarker {
  __truncated__: true;
  __omitted_reason__: 'blob_upload_failed';
  __bytes__: number;
  __preview__: string;
}

export type PayloadMarker = BlobRefMarker | TruncationMarker;

export function isPayloadMarker(v: unknown): v is PayloadMarker {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (typeof o.__blob_ref__ === 'string' && o.__omitted__ === true) ||
    (o.__truncated__ === true && typeof o.__preview__ === 'string')
  );
}

/**
 * Walk a payload and offload any oversized string leaf to Blob storage.
 * Returns the sanitized payload (same shape, strings replaced by markers)
 * plus a summary of what was offloaded. The input is not mutated.
 *
 * Safe to call with any JSON-serializable value; non-serializable values are
 * left untouched (stringified only at the leaf level).
 */
export async function sanitizeToolActivityPayload(
  payload: unknown,
  options: SanitizeOptions = {},
): Promise<{ sanitized: unknown; offloaded: OffloadSummary[] }> {
  const opts = { ...DEFAULT_SANITIZE_OPTIONS, ...options };
  const offloaded: OffloadSummary[] = [];
  const sanitized = await walk(payload, opts, '', offloaded);
  return { sanitized, offloaded };
}

interface OffloadSummary {
  path: string;
  bytes: number;
  reason: 'oversized_text' | 'inline_image_base64';
  blobUrl: string | null;
}

async function walk(
  value: unknown,
  opts: Required<Omit<SanitizeOptions, 'access'>> & {
    access?: BlobAccess;
  },
  path: string,
  offloaded: OffloadSummary[],
): Promise<unknown> {
  if (typeof value === 'string') {
    return await offloadIfLarge(value, opts, path, offloaded);
  }
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((v, i) =>
        walk(v, opts, path ? `${path}[${i}]` : `[${i}]`, offloaded),
      ),
    );
  }
  if (value !== null && typeof value === 'object') {
    // Reject values that aren't plain JSON-ish objects (class instances etc).
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      !(value instanceof Date)
    ) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      out[k] = await walk(v, opts, childPath, offloaded);
    }
    return out;
  }
  return value;
}

async function offloadIfLarge(
  text: string,
  opts: Required<Omit<SanitizeOptions, 'access'>> & { access?: BlobAccess },
  path: string,
  offloaded: OffloadSummary[],
): Promise<unknown> {
  const byteLen = utf8ByteLength(text);
  const imageKind = classifyInlineImage(text);
  const isImage = imageKind !== null;
  const threshold = isImage
    ? opts.imageBase64Threshold
    : opts.textByteThreshold;

  if (byteLen <= threshold) return text;

  const reason: OffloadSummary['reason'] = isImage
    ? 'inline_image_base64'
    : 'oversized_text';

  // Attempt Blob offload. On any failure, fall back to truncation so the row
  // is always safe to insert (never propagate a blob error up to the DB write).
  try {
    const mime = isImage ? (imageKind as string) : guessTextMime(text, path);
    const ext = extensionForMime(mime);
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    const pathname = `${opts.pathnamePrefix}/${stamp}-${rand}${ext}`;
    const body = isImage
      ? decodeBase64ToBuffer(text)
      : Buffer.from(text, 'utf8');
    const result = await put(pathname, body, {
      access: opts.access,
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    offloaded.push({ path, bytes: byteLen, reason, blobUrl: result.url });
    return {
      __blob_ref__: result.url,
      __omitted__: true as const,
      __omitted_reason__: reason,
      __bytes__: byteLen,
      ...(mime ? { __mime_type__: mime } : {}),
    } satisfies BlobRefMarker;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('offload_failed_fallback_truncate', {
      path,
      bytes: byteLen,
      error: msg,
    });
    const previewBytes = opts.fallbackTruncateBytes;
    const preview = safeSliceUtf8(text, previewBytes);
    offloaded.push({ path, bytes: byteLen, reason, blobUrl: null });
    return {
      __truncated__: true as const,
      __omitted_reason__: 'blob_upload_failed',
      __bytes__: byteLen,
      __preview__: preview,
    } satisfies TruncationMarker;
  }
}

/**
 * Returns the image MIME kind if the string looks like an inline base64 image,
 * else null. Same prefixes as AionCore's `is_probably_inline_image_result`:
 * PNG / JPEG / WebP / GIF / `data:image/...`.
 */
function classifyInlineImage(text: string): string | null {
  // Length guard done by caller; here we only inspect the prefix.
  if (text.startsWith('data:image/')) {
    const semi = text.indexOf(';');
    if (semi > 11) return text.slice(5, semi); // image/png, image/jpeg...
    return 'image/png';
  }
  if (text.startsWith('iVBORw0KGgo')) return 'image/png';
  if (text.startsWith('/9j/')) return 'image/jpeg';
  if (text.startsWith('UklGR')) return 'image/webp';
  if (text.startsWith('R0lGODlh')) return 'image/gif';
  return null;
}

function guessTextMime(_text: string, path: string): string {
  // Heuristic by field name; default JSON for `result`/`arguments`, plain for
  // stdout-like fields.
  if (/output_?text|stdout|stderr|error/i.test(path)) {
    return 'text/plain';
  }
  return 'application/json';
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'text/plain':
      return '.txt';
    default:
      return '.json';
  }
}

function utf8ByteLength(text: string): number {
  // TextEncoder already measures UTF-8 byte length; avoid the overhead for the
  // common ASCII case (most tool outputs are ASCII).
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  return ascii ? text.length : new TextEncoder().encode(text).length;
}

function safeSliceUtf8(text: string, maxBytes: number): string {
  // Slice on UTF-8 boundaries so we never split a multibyte char.
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // Walk back to the previous char boundary.
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  const sliced = bytes.slice(0, cut);
  const decoded = new TextDecoder().decode(sliced);
  return `${decoded}\n...[truncated at ${cut} bytes, blob upload failed]`;
}

function decodeBase64ToBuffer(b64: string): Buffer {
  // Handle the `data:image/png;base64,....` URI form.
  const comma = b64.indexOf(',');
  const data =
    b64.startsWith('data:') && comma > 0 ? b64.slice(comma + 1) : b64;
  // Node's Buffer is available on the server (this module is server-only —
  // it writes to the DB and Blob). Using it directly avoids pulling in a
  // JS-only base64 decoder and gives us a Buffer that satisfies the Blob
  // put() body type.
  return Buffer.from(data, 'base64');
}

// Lazy logger loader — avoids importing the server logger at module top so the
// module stays safe to import from anywhere (mirrors blob/index.ts style).
function createLazyLogger(scope: string) {
  return {
    async warn(event: string, meta: Record<string, unknown>) {
      const { createLogger } = await import('@/lib/utils/logger');
      createLogger(scope).warn(event, meta);
    },
  };
}
