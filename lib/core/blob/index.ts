import {
  del,
  get,
  getDownloadUrl,
  list,
  put as vercelBlobPut,
} from '@vercel/blob';
import type { PutBlobResult, PutCommandOptions } from '@vercel/blob';

export { del, get, getDownloadUrl, list };

export type BlobAccess = 'public' | 'private';

const PRIVATE_STORE_PUBLIC_ACCESS_ERROR =
  'Cannot use public access on a private store';
const PUBLIC_STORE_PRIVATE_ACCESS_ERROR =
  'Cannot use private access on a public store';

export function getConfiguredBlobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';
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
  body: Parameters<typeof vercelBlobPut>[1],
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
    return await vercelBlobPut(pathname, body, putOptions);
  } catch (error) {
    if (access === 'private' && shouldRetryWithPublicAccess(error)) {
      return vercelBlobPut(pathname, body, {
        ...options,
        access: 'public',
      });
    }

    if (access === 'public' && shouldRetryWithPrivateAccess(error)) {
      return vercelBlobPut(pathname, body, {
        ...options,
        access: 'private',
      });
    }

    throw error;
  }
}
