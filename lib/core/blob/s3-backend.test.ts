/**
 * Contract tests for the S3 backend's body normalization (`toBytes`).
 *
 * `toBytes` is the one piece of the S3 backend with real branching: it has to
 * accept every shape `@vercel/blob`'s `put()` accepts — string, Blob/File,
 * ArrayBuffer, any ArrayBufferView (Buffer, typed arrays, DataView), a Web
 * ReadableStream, and a Node Readable (async-iterable) — and flatten it to a
 * Uint8Array for a single-shot PutObjectCommand. These cases guard the
 * backend↔wrapper contract (lib/core/blob/index.ts `put`) without a live S3.
 *
 * Run via: yarn test lib/core/blob/s3-backend.test.ts
 */
import { describe, expect, it } from 'vitest';
import { toBytes } from './s3-backend';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('toBytes', () => {
  it('encodes a string as UTF-8', async () => {
    const out = await toBytes('héllo');
    expect(decode(out)).toBe('héllo');
  });

  it('returns a Uint8Array through directly', async () => {
    const src = new Uint8Array([1, 2, 3]);
    expect(Array.from(await toBytes(src))).toEqual([1, 2, 3]);
  });

  it('handles a Node Buffer (Uint8Array subclass)', async () => {
    const buf = Buffer.from('abc', 'utf8');
    expect(decode(await toBytes(buf))).toBe('abc');
  });

  it('wraps a non-Uint8Array typed-array view over its bytes', async () => {
    // Int16Array of [1] → little-endian bytes 0x01 0x00.
    const view = new Int16Array([1]);
    const out = await toBytes(view);
    expect(Array.from(out)).toEqual([1, 0]);
  });

  it('respects a typed-array view offset (does not leak the whole buffer)', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    // View the middle three bytes only.
    const view = backing.subarray(2, 5);
    const out = await toBytes(view);
    expect(Array.from(out)).toEqual([2, 3, 4]);
  });

  it('handles an ArrayBuffer', async () => {
    const ab = new Uint8Array([9, 8, 7]).buffer;
    expect(Array.from(await toBytes(ab))).toEqual([9, 8, 7]);
  });

  it('handles a Blob', async () => {
    const blob = new Blob(['blob-body']);
    expect(decode(await toBytes(blob))).toBe('blob-body');
  });

  it('drains a Web ReadableStream and concatenates chunks in order', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const out = await toBytes(stream);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drains a Node Readable (async-iterable of Buffers)', async () => {
    async function* gen() {
      yield Buffer.from('foo');
      yield Buffer.from('bar');
    }
    // A minimal async-iterable stand-in for fs.createReadStream.
    const iterable: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => gen(),
    };
    expect(decode(await toBytes(iterable))).toBe('foobar');
  });

  it('encodes string chunks yielded by an async-iterable', async () => {
    async function* gen() {
      yield 'ab';
      yield 'cd';
    }
    const iterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => gen(),
    };
    expect(decode(await toBytes(iterable))).toBe('abcd');
  });

  it('throws on an unsupported body type', async () => {
    await expect(toBytes(42 as unknown)).rejects.toThrow(
      'Unsupported blob body type',
    );
  });
});
