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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { s3Del, s3Put, toBytes } from './s3-backend';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// The S3 backend loads the AWS SDK via `await import('@aws-sdk/client-s3')`
// inside buildClient(). Mock the module so `client.send` is a single spy we can
// reconfigure per test; the command classes just capture their input so we can
// assert on it. getClient() caches the client promise module-wide, so the same
// `send` spy is reused across tests — reset it in beforeEach.
const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DeleteObjectsCommand {
    input: { Delete: { Objects: Array<{ Key: string }> } };
    constructor(input: { Delete: { Objects: Array<{ Key: string }> } }) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class ListObjectsV2Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send = send;
    },
    PutObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    ListObjectsV2Command,
  };
});

beforeEach(() => {
  send.mockReset();
  vi.stubEnv('S3_BUCKET', 'test-bucket');
  vi.stubEnv('S3_ACCESS_KEY_ID', 'key');
  vi.stubEnv('S3_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('PUBLIC_APP_URL', 'https://example.test');
  vi.stubEnv('AUTH_SECRET', 'test-secret');
});

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

describe('s3Put overwrite guard', () => {
  it('sets If-None-Match: * by default (anti-clobber)', async () => {
    send.mockResolvedValueOnce({});
    await s3Put('a/b.txt', 'hi');
    const cmd = send.mock.calls[0][0] as { input: { IfNoneMatch?: string } };
    expect(cmd.input.IfNoneMatch).toBe('*');
  });

  it('omits If-None-Match when allowOverwrite is true', async () => {
    send.mockResolvedValueOnce({});
    await s3Put('a/b.txt', 'hi', { allowOverwrite: true });
    const cmd = send.mock.calls[0][0] as { input: { IfNoneMatch?: string } };
    expect(cmd.input.IfNoneMatch).toBeUndefined();
  });

  it('omits If-None-Match when addRandomSuffix is true (key is unique)', async () => {
    send.mockResolvedValueOnce({});
    await s3Put('a/b.txt', 'hi', { addRandomSuffix: true });
    const cmd = send.mock.calls[0][0] as { input: { IfNoneMatch?: string } };
    expect(cmd.input.IfNoneMatch).toBeUndefined();
  });

  it('maps a 412 PreconditionFailed to a friendly already-exists error', async () => {
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } });
    await expect(s3Put('a/b.txt', 'hi')).rejects.toThrow(/already exists/i);
  });

  it('rethrows non-precondition errors unchanged', async () => {
    send.mockRejectedValueOnce(new Error('network down'));
    await expect(s3Put('a/b.txt', 'hi')).rejects.toThrow('network down');
  });
});

describe('s3Del batching + per-object error surfacing', () => {
  it('pages deletes into batches of 1000', async () => {
    send.mockResolvedValue({});
    const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
    await s3Del(keys);
    expect(send).toHaveBeenCalledTimes(3);
    const sizes = send.mock.calls.map(
      (c) =>
        (c[0] as { input: { Delete: { Objects: unknown[] } } }).input.Delete
          .Objects.length,
    );
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('throws when DeleteObjects reports per-object Errors', async () => {
    send.mockResolvedValueOnce({
      Errors: [{ Key: 'k/1', Code: 'AccessDenied', Message: 'nope' }],
    });
    await expect(s3Del(['k/1', 'k/2'])).rejects.toThrow(/k\/1: AccessDenied/);
  });

  it('no-ops on an empty key list', async () => {
    await s3Del([]);
    expect(send).not.toHaveBeenCalled();
  });
});
