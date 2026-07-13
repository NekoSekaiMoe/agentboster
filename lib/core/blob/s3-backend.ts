/**
 * S3 / MinIO blob backend for self-hosted deployments.
 *
 * Implements the subset of the Vercel Blob API that `lib/core/blob/index.ts`
 * forwards (`put` / `getBlob` / `list` / `del`), with return shapes matching
 * what the callers actually read (verified against every call site):
 *
 *   - put(...)      → { url, pathname, contentType, downloadUrl } — callers
 *                     only read `.url`, which we return as a SIGNED PROXY URL
 *                     (see proxy-link.ts), not an S3 URL, so the LLM/browser
 *                     can fetch it through our own route.
 *   - getBlob(path) → { statusCode, stream, blob: { contentType } } | null —
 *                     the download route and skills reader check
 *                     `statusCode === 200`, then read `stream` and
 *                     `blob.contentType`.
 *   - list({...})   → { blobs: [{ pathname, url }], hasMore, cursor } — skills
 *                     prefix-paginates and reads `pathname` + `url`.
 *   - del(paths)    → void — array form only; return value ignored.
 *
 * The AWS SDK is loaded via `await import()` (never a top-level import): the
 * blob wrapper is reached from the sandbox tool through
 * `await import('@/lib/core/blob')`, and the SDK pulls in `node:*`. Dynamic
 * import keeps it invisible to the workflow bundler's static walk.
 *
 * Config (env):
 *   S3_BUCKET            — required, target bucket
 *   S3_ACCESS_KEY_ID     — required
 *   S3_SECRET_ACCESS_KEY — required
 *   S3_ENDPOINT          — optional, for MinIO / non-AWS (e.g. http://minio:9000)
 *   S3_REGION            — optional, defaults to 'us-east-1'
 *   S3_FORCE_PATH_STYLE  — optional, defaults true when S3_ENDPOINT is set
 *                          (MinIO needs path-style addressing)
 */

import { getPublicAppUrl } from '@/lib/deploy';
import { signBlobUrl } from './proxy-link';

// The client and command types are inferred from `buildClient()` below via
// `ReturnType<typeof buildClient>`, so no top-level SDK type reference is
// needed here — the module is loaded lazily inside getClient().

type PutResult = {
  url: string;
  pathname: string;
  contentType?: string;
  downloadUrl: string;
};

type GetBlobResult = {
  statusCode: number;
  stream: ReadableStream<Uint8Array>;
  blob: { contentType?: string };
} | null;

type ListBlob = { pathname: string; url: string };
type ListResult = { blobs: ListBlob[]; hasMore: boolean; cursor?: string };

type PutOptions = {
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  contentType?: string;
  access?: 'public' | 'private';
};

type ListOptions = {
  prefix?: string;
  limit?: number;
  cursor?: string;
};

let _clientPromise: ReturnType<typeof buildClient> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} env var is required for the S3 blob backend`);
  }
  return value;
}

async function buildClient() {
  const mod = await import('@aws-sdk/client-s3');
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE
    ? process.env.S3_FORCE_PATH_STYLE === 'true'
    : Boolean(endpoint);
  const client = new mod.S3Client({
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    endpoint: endpoint || undefined,
    forcePathStyle,
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    },
  });
  return { client, bucket: requireEnv('S3_BUCKET'), commands: mod };
}

function getClient() {
  if (!_clientPromise) {
    _clientPromise = buildClient();
  }
  return _clientPromise;
}

/** Append a short random suffix before the file extension, Vercel-style. */
function withRandomSuffix(pathname: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const lastSlash = pathname.lastIndexOf('/');
  const dir = lastSlash >= 0 ? pathname.slice(0, lastSlash + 1) : '';
  const name = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
  }
  return `${dir}${name}-${suffix}`;
}

async function toBytes(
  body: Blob | Buffer | string | Uint8Array,
): Promise<Uint8Array> {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  // Blob (and Buffer, which is a Uint8Array subclass handled above).
  if (typeof (body as Blob).arrayBuffer === 'function') {
    return new Uint8Array(await (body as Blob).arrayBuffer());
  }
  throw new Error('Unsupported blob body type');
}

export async function s3Put(
  pathname: string,
  body: Blob | Buffer | string | Uint8Array,
  options?: PutOptions,
): Promise<PutResult> {
  const { client, bucket, commands } = await getClient();
  const key =
    options?.addRandomSuffix === true ? withRandomSuffix(pathname) : pathname;
  const bytes = await toBytes(body);

  await client.send(
    new commands.PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: options?.contentType,
    }),
  );

  const url = await signBlobUrl({ baseUrl: getPublicAppUrl(), blobPath: key });
  return {
    url,
    downloadUrl: url,
    pathname: key,
    contentType: options?.contentType,
  };
}

export async function s3GetBlob(pathname: string): Promise<GetBlobResult> {
  const { client, bucket, commands } = await getClient();
  try {
    const result = (await client.send(
      new commands.GetObjectCommand({ Bucket: bucket, Key: pathname }),
    )) as {
      Body?: { transformToWebStream?: () => ReadableStream<Uint8Array> };
      ContentType?: string;
    };

    const webStream = result.Body?.transformToWebStream?.();
    if (!webStream) {
      return { statusCode: 404, stream: emptyStream(), blob: {} };
    }

    return {
      statusCode: 200,
      stream: webStream,
      blob: { contentType: result.ContentType },
    };
  } catch (error) {
    // NoSuchKey / NotFound → treat as a missing blob (statusCode 404) so the
    // caller's `statusCode !== 200` branch fires, matching Vercel's behavior.
    if (isNotFound(error)) {
      return { statusCode: 404, stream: emptyStream(), blob: {} };
    }
    throw error;
  }
}

export async function s3List(options?: ListOptions): Promise<ListResult> {
  const { client, bucket, commands } = await getClient();
  const result = (await client.send(
    new commands.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: options?.prefix,
      MaxKeys: options?.limit,
      ContinuationToken: options?.cursor,
    }),
  )) as {
    Contents?: Array<{ Key?: string }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  };

  const baseUrl = getPublicAppUrl();
  const contents = result.Contents ?? [];
  const blobs: ListBlob[] = await Promise.all(
    contents
      .filter((obj): obj is { Key: string } => typeof obj.Key === 'string')
      .map(async (obj) => ({
        pathname: obj.Key,
        url: await signBlobUrl({ baseUrl, blobPath: obj.Key }),
      })),
  );

  return {
    blobs,
    hasMore: Boolean(result.IsTruncated),
    cursor: result.IsTruncated ? result.NextContinuationToken : undefined,
  };
}

export async function s3Del(pathnames: string | string[]): Promise<void> {
  const keys = Array.isArray(pathnames) ? pathnames : [pathnames];
  if (keys.length === 0) return;
  const { client, bucket, commands } = await getClient();
  // DeleteObjectsCommand handles up to 1000 keys per call.
  await client.send(
    new commands.DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}
