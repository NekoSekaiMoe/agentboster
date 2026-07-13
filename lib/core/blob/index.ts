import type { PutBlobResult, PutCommandOptions } from '@vercel/blob';
import { isVercel } from '@/lib/deploy';

export type BlobAccess = 'public' | 'private';
type VercelBlobModule = typeof import('@vercel/blob');

let blobModule: Promise<VercelBlobModule> | null = null;

async function loadBlob(): Promise<VercelBlobModule> {
  blobModule ??= import('@vercel/blob');
  return blobModule;
}

type S3Backend = typeof import('./s3-backend');
let s3Module: Promise<S3Backend> | null = null;
async function loadS3(): Promise<S3Backend> {
  s3Module ??= import('./s3-backend');
  return s3Module;
}

const PRIVATE_STORE_PUBLIC_ACCESS_ERROR =
  'Cannot use public access on a private store';
const PUBLIC_STORE_PRIVATE_ACCESS_ERROR =
  'Cannot use private access on a public store';

export function getConfiguredBlobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';
}

/**
 * Blob storage layer with two interchangeable backends, selected by deployment
 * mode:
 *
 *  - Vercel      → Vercel Blob (`@vercel/blob`, `BLOB_READ_WRITE_TOKEN`).
 *  - Self-hosted → S3/MinIO (`./s3-backend`, `S3_*` env). `put`/`list` return a
 *                  signed proxy URL (`/api/blob/...`) instead of an S3 URL so
 *                  the LLM and browser can fetch through our own route.
 *
 * Both backends are loaded via `await import()` so neither the Vercel SDK nor
 * the AWS SDK is pulled into any bundle that doesn't use it — and, critically,
 * so the AWS SDK's `node:*` deps stay invisible to the workflow bundler (this
 * module is reached from the sandbox tool via `await import('@/lib/core/blob')`).
 */

export type BlobGetResult = {
  statusCode: number;
  stream: ReadableStream;
  blob: { contentType?: string };
} | null;

export async function del(
  ...args: Parameters<VercelBlobModule['del']>
): Promise<void> {
  if (!isVercel) {
    const s3 = await loadS3();
    await s3.s3Del(args[0] as string | string[]);
    return;
  }
  const blob = await loadBlob();
  await blob.del(...args);
}

export async function list(
  ...args: Parameters<VercelBlobModule['list']>
): Promise<{
  blobs: Array<{ pathname: string; url: string }>;
  hasMore: boolean;
  cursor?: string;
}> {
  if (!isVercel) {
    const s3 = await loadS3();
    const opts = (args[0] ?? {}) as {
      prefix?: string;
      limit?: number;
      cursor?: string;
    };
    return s3.s3List(opts);
  }
  const blob = await loadBlob();
  return blob.list(...args);
}

export async function getDownloadUrl(
  ...args: Parameters<VercelBlobModule['getDownloadUrl']>
): Promise<ReturnType<VercelBlobModule['getDownloadUrl']>> {
  const blob = await loadBlob();
  return blob.getDownloadUrl(...args);
}

function shouldRetryWithPrivateAccess(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(PRIVATE_STORE_PUBLIC_ACCESS_ERROR)
  );
}

function shouldRetryWithPublicAccess(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(PUBLIC_STORE_PRIVATE_ACCESS_ERROR)
  );
}

export async function getBlob(
  pathname: string,
  options?: Omit<Parameters<VercelBlobModule['get']>[1], 'access'> & {
    access?: BlobAccess;
  },
): Promise<BlobGetResult> {
  if (!isVercel) {
    const s3 = await loadS3();
    return s3.s3GetBlob(pathname);
  }

  const blob = await loadBlob();
  const access = options?.access ?? getConfiguredBlobAccess();
  const fallbackAccess: BlobAccess = access === 'public' ? 'private' : 'public';

  try {
    const result = await blob.get(pathname, { ...options, access });
    if (!result) {
      return (await blob.get(pathname, {
        ...options,
        access: fallbackAccess,
      })) as BlobGetResult;
    }
    return result as BlobGetResult;
  } catch (error) {
    if (access === 'private' && shouldRetryWithPublicAccess(error)) {
      return (await blob.get(pathname, {
        ...options,
        access: 'public',
      })) as BlobGetResult;
    }

    if (access === 'public' && shouldRetryWithPrivateAccess(error)) {
      return (await blob.get(pathname, {
        ...options,
        access: 'private',
      })) as BlobGetResult;
    }

    throw error;
  }
}

export async function put(
  pathname: string,
  body: Parameters<VercelBlobModule['put']>[1],
  options: Omit<PutCommandOptions, 'access'> & {
    access?: BlobAccess;
  } = {},
): Promise<PutBlobResult> {
  if (!isVercel) {
    const s3 = await loadS3();
    const result = await s3.s3Put(pathname, body as Blob | Buffer | string, {
      addRandomSuffix: options.addRandomSuffix,
      allowOverwrite: options.allowOverwrite,
      contentType: options.contentType,
      access: options.access ?? getConfiguredBlobAccess(),
    });
    // Shape as PutBlobResult — callers only read `.url` and `.pathname`.
    return {
      url: result.url,
      downloadUrl: result.downloadUrl,
      pathname: result.pathname,
      contentType: result.contentType ?? '',
      contentDisposition: '',
    } as PutBlobResult;
  }

  const access = options.access ?? getConfiguredBlobAccess();
  const putOptions = { ...options, access };

  try {
    const blob = await loadBlob();
    return await blob.put(pathname, body, putOptions);
  } catch (error) {
    if (access === 'private' && shouldRetryWithPublicAccess(error)) {
      const blob = await loadBlob();
      return blob.put(pathname, body, { ...options, access: 'public' });
    }

    if (access === 'public' && shouldRetryWithPrivateAccess(error)) {
      const blob = await loadBlob();
      return blob.put(pathname, body, { ...options, access: 'private' });
    }

    throw error;
  }
}
