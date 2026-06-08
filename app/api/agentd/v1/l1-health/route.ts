import { getConfig } from '@/lib/core/kv/config';
import { resolveLanguageModel } from '@/lib/ai';
import { resolveL1ScorerModelId } from '@/lib/security/l1-model';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l1-health');

export async function GET() {
  try {
    const config = await getConfig();
    const providers = config.models?.providers ?? {};
    const providerNames = Object.keys(providers);

    if (providerNames.length === 0) {
      return Response.json(
        {
          success: false,
          error: 'No model providers configured',
          data: {
            configuredProviders: providerNames,
          },
        },
        { status: 503 },
      );
    }

    const modelId = resolveL1ScorerModelId(config);
    resolveLanguageModel(modelId, config);

    logger.info('l1 health checked', {
      modelId,
      providers: providerNames,
    });

    return Response.json({
      success: true,
      data: {
        modelId,
        providers: providerNames,
      },
    });
  } catch (error) {
    logger.error('l1 health failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'L1 health check failed',
      },
      { status: 500 },
    );
  }
}
