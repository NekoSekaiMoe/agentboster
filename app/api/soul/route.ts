/**
 * Global SOUL.md API
 * Returns the global SOUL built-in memory content.
 * Used by agentd to fetch SOUL for injection into system prompts.
 */

import { getBuiltinMemorySection } from '@/lib/memory';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.soul');

export async function GET() {
  try {
    const section = await getBuiltinMemorySection('SOUL');

    return Response.json({
      success: true,
      data: {
        content: section.content,
        updatedAt: section.updatedAt,
      },
    });
  } catch (error) {
    logger.error('failed to get global soul', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'Failed to get SOUL',
      },
      { status: 500 },
    );
  }
}
