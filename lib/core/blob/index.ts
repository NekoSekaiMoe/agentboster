import type { PutBlobResult, PutCommandOptions } from '@vercel/blob';

export type BlobAccess = 'public' | 'private';
type VercelBlobModule = typeof import('@vercel/blob');

let blobModule: Promise<VercelBlobModule> | null = null;

async function loadBlob(): Promise<VercelBlobModule> {
  blobModule ??= import('@vercel/blob');
  return blobModule;
}

const PRIVATE_STORE_PUBLIC_ACCESS_ERROR =
  'Cannot use public access on a private store';
const PUBLIC_STORE_PRIVATE_ACCESS_ERROR =
  'Cannot use private access on a public store';

export function getConfiguredBlobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';
}

export async function del(
  ...args: Parameters<VercelBlobModule['del']>
): ReturnType<VercelBlobModule['del']> {
  const blob = await loadBlob();
  return blob.del(...args);
}

export async function get(
  ...args: Parameters<VercelBlobModule['get']>
): ReturnType<VercelBlobModule['get']> {
  const blob = await loadBlob();
  return blob.get(...args);
}

export async function getDownloadUrl(
  ...args: Parameters<VercelBlobModule['getDownloadUrl']>
): Promise<ReturnType<VercelBlobModule['getDownloadUrl']>> {
  const blob = await loadBlob();
  return blob.getDownloadUrl(...args);
}

export async function list(
  ...args: Parameters<VercelBlobModule['list']>
): ReturnType<VercelBlobModule['list']> {
  const blob = await loadBlob();
  return blob.list(...args);
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
  options?: Omit<Parameters<typeof get>[1], 'access'> & {
    access?: BlobAccess;
  },
): ReturnType<typeof get> {
  const access = options?.access ?? getConfiguredBlobAccess();
  const fallbackAccess: BlobAccess = access === 'public' ? 'private' : 'public';

  try {
    const result = await get(pathname, {
      ...options,
      access,
    });
    if (!result) {
      return get(pathname, {
        ...options,
        access: fallbackAccess,
      });
    }
    return result;
  } catch (error) {
    if (access === 'private' && shouldRetryWithPublicAccess(error)) {
      return get(pathname, {
        ...options,
        access: 'public',
      });
    }

    if (access === 'public' && shouldRetryWithPrivateAccess(error)) {
      return get(pathname, {
        ...options,
        access: 'private',
      });
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
  const access = options.access ?? getConfiguredBlobAccess();
  const putOptions = {
    ...options,
    access,
  };

  try {
    const blob = await loadBlob();
    return await blob.put(pathname, body, putOptions);
  } catch (error) {
    if (access === 'private' && shouldRetryWithPublicAccess(error)) {
      const blob = await loadBlob();
      return blob.put(pathname, body, {
        ...options,
        access: 'public',
      });
    }

    if (access === 'public' && shouldRetryWithPrivateAccess(error)) {
      const blob = await loadBlob();
      return blob.put(pathname, body, {
        ...options,
        access: 'private',
      });
    }

    throw error;
  }
}
