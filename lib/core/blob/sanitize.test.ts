import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the blob `put` so tests don't touch real storage. Each test can
// override mockPut's behaviour via `putImpl`.
const putMock = vi.fn();
vi.mock('@/lib/core/blob', () => ({
  put: (...args: unknown[]) => putMock(...args),
}));

import {
  sanitizeToolActivityPayload,
  isPayloadMarker,
  type BlobRefMarker,
  type TruncationMarker,
} from './sanitize';

function makeBlobResult(url: string) {
  return {
    url,
    pathname: url,
    downloadUrl: url,
    contentType: '',
    contentDisposition: '',
  };
}

describe('sanitizeToolActivityPayload', () => {
  beforeEach(() => {
    putMock.mockReset();
    putMock.mockResolvedValue(makeBlobResult('https://blob.example.com/x'));
  });

  it('leaves small payloads untouched', async () => {
    const input = { result: 'ok', n: 3, arr: ['a', 'b'] };
    const { sanitized, offloaded } = await sanitizeToolActivityPayload(input);
    expect(sanitized).toEqual(input);
    expect(offloaded).toEqual([]);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('offloads a large text string to blob and leaves a marker', async () => {
    const big = 'x'.repeat(70 * 1024); // > 64KB default threshold
    const { sanitized, offloaded } = await sanitizeToolActivityPayload({
      result: big,
      other: 'small',
    });
    const result = (sanitized as { result: BlobRefMarker }).result;
    expect(isPayloadMarker(result)).toBe(true);
    expect(result.__blob_ref__).toBe('https://blob.example.com/x');
    expect(result.__omitted__).toBe(true);
    expect(result.__omitted_reason__).toBe('oversized_text');
    expect(result.__bytes__).toBe(big.length);
    // sibling field preserved
    expect((sanitized as { other: string }).other).toBe('small');
    expect(offloaded).toHaveLength(1);
    expect(offloaded[0].path).toBe('result');
  });

  it('offloads base64 image at the smaller image threshold', async () => {
    // 10KB PNG-looking base64 — below 64KB text threshold but above 8KB image.
    const pngB64 = `iVBORw0KGgo${'A'.repeat(10 * 1024)}`;
    const { sanitized, offloaded } = await sanitizeToolActivityPayload({
      arguments: { image: pngB64 },
    });
    const marker = (sanitized as { arguments: { image: BlobRefMarker } })
      .arguments.image;
    expect(isPayloadMarker(marker)).toBe(true);
    expect(marker.__omitted_reason__).toBe('inline_image_base64');
    expect(marker.__mime_type__).toBe('image/png');
    expect(offloaded[0].reason).toBe('inline_image_base64');
  });

  it('handles data: URI images', async () => {
    const dataUri = `data:image/png;base64,${'B'.repeat(10 * 1024)}`;
    const { sanitized } = await sanitizeToolActivityPayload({
      result: dataUri,
    });
    const marker = (sanitized as { result: BlobRefMarker }).result;
    expect(marker.__mime_type__).toBe('image/png');
    expect(marker.__blob_ref__).toBeTruthy();
  });

  it('walks nested objects and arrays', async () => {
    const big = 'z'.repeat(70 * 1024);
    const input = {
      a: { b: { c: big } },
      list: [big, 'small', { deep: big }],
    };
    const { sanitized, offloaded } = await sanitizeToolActivityPayload(input);
    const out = sanitized as {
      a: { b: { c: BlobRefMarker } };
      list: [BlobRefMarker, string, { deep: BlobRefMarker }];
    };
    expect(isPayloadMarker(out.a.b.c)).toBe(true);
    expect(isPayloadMarker(out.list[0])).toBe(true);
    expect(out.list[1]).toBe('small');
    expect(isPayloadMarker(out.list[2].deep)).toBe(true);
    const paths = offloaded.map((o) => o.path).sort();
    expect(paths).toEqual(['a.b.c', 'list[0]', 'list[2].deep']);
  });

  it('falls back to truncation when blob upload throws', async () => {
    putMock.mockRejectedValueOnce(new Error('S3 down'));
    const big = 'q'.repeat(70 * 1024);
    const { sanitized, offloaded } = await sanitizeToolActivityPayload({
      result: big,
    });
    const marker = (sanitized as { result: TruncationMarker }).result;
    expect(marker.__truncated__).toBe(true);
    expect(marker.__omitted_reason__).toBe('blob_upload_failed');
    expect(marker.__bytes__).toBe(big.length);
    expect(marker.__preview__.length).toBeLessThan(big.length);
    expect(marker.__preview__).toMatch(/truncated/);
    expect(offloaded[0].blobUrl).toBeNull();
  });

  it('respects a custom text threshold', async () => {
    const { sanitized, offloaded } = await sanitizeToolActivityPayload(
      { result: 'medium'.repeat(100) }, // ~600 bytes
      { textByteThreshold: 200 },
    );
    expect(offloaded).toHaveLength(1);
    expect(
      isPayloadMarker((sanitized as { result: BlobRefMarker }).result),
    ).toBe(true);
  });

  it('count bytes correctly for multibyte (UTF-8) text', async () => {
    // Each '字' is 3 UTF-8 bytes. 30000 chars => 90000 bytes => > 64KB.
    const big = '字'.repeat(30000);
    const { sanitized, offloaded } = await sanitizeToolActivityPayload({
      result: big,
    });
    expect(offloaded[0].bytes).toBe(90000);
    const marker = (sanitized as { result: BlobRefMarker }).result;
    expect(marker.__bytes__).toBe(90000);
  });

  it('truncation preview lands on a UTF-8 boundary', async () => {
    putMock.mockRejectedValueOnce(new Error('fail'));
    const big = '字'.repeat(30000);
    const { sanitized } = await sanitizeToolActivityPayload({ result: big });
    const marker = (sanitized as { result: TruncationMarker }).result;
    // The preview must be decodable (no replacement chars from split multibyte)
    // and shorter than the original.
    expect(marker.__preview__.length).toBeLessThan(big.length);
    // Original char '字' should still appear in the surviving prefix.
    expect(marker.__preview__).toContain('字');
  });

  it('leaves non-plain objects (class instances) untouched', async () => {
    class Foo {
      val = 'x'.repeat(70 * 1024);
    }
    const input = { foo: new Foo() };
    const { sanitized, offloaded } = await sanitizeToolActivityPayload(input);
    // Not walked — instance preserved as-is, nothing offloaded.
    expect(offloaded).toEqual([]);
    expect((sanitized as { foo: Foo }).foo).toBeInstanceOf(Foo);
  });

  it('isPayloadMarker detects both marker shapes', () => {
    expect(
      isPayloadMarker({
        __blob_ref__: 'u',
        __omitted__: true,
        __omitted_reason__: 'oversized_text',
        __bytes__: 1,
      }),
    ).toBe(true);
    expect(
      isPayloadMarker({
        __truncated__: true,
        __omitted_reason__: 'blob_upload_failed',
        __bytes__: 1,
        __preview__: 'p',
      }),
    ).toBe(true);
    expect(isPayloadMarker({ result: 'small' })).toBe(false);
    expect(isPayloadMarker(null)).toBe(false);
  });

  it('does not mutate the input', async () => {
    const big = 'y'.repeat(70 * 1024);
    const input = { result: big, nested: { deep: big } };
    const snapshot = JSON.parse(JSON.stringify(input));
    await sanitizeToolActivityPayload(input);
    // Input untouched (output is a new structure).
    expect(input).toEqual(snapshot);
  });
});
