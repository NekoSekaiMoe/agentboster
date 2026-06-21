export const dynamic = 'force-dynamic';

import { put } from '@/lib/core/blob';
import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  requireTaskAccess,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.blob-upload');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { task_id, file_name, content } = body;

    if (!task_id || !file_name || !content) {
      return Response.json(
        { success: false, error: 'Missing task_id, file_name, or content' },
        { status: 400 },
      );
    }

    await requireTaskAccess({ taskId: task_id });

    const fileBuffer = Buffer.from(content, 'base64');
    if (fileBuffer.length > MAX_FILE_SIZE) {
      return Response.json(
        {
          success: false,
          error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`,
        },
        { status: 413 },
      );
    }

    const safeFileName = String(file_name).split(/[\\/]/).pop()?.trim();
    if (!safeFileName || safeFileName === '.' || safeFileName === '..') {
      return Response.json(
        { success: false, error: 'Invalid file_name' },
        { status: 400 },
      );
    }

    const blobPath = `task-deliveries/${task_id}/${safeFileName}`;
    const blobResult = await put(blobPath, fileBuffer, {
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    logger.info('blob uploaded', {
      taskId: task_id,
      fileName: safeFileName,
      size: fileBuffer.length,
    });

    return Response.json({
      success: true,
      data: {
        url: blobResult.url,
        blob_path: blobPath,
        expires_at: null,
        size: fileBuffer.length,
      },
    });
  } catch (error) {
    logger.error('blob upload failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
