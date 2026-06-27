import { withCliAuth } from '@/lib/cli/auth';
import { getConfig } from '@/lib/core/kv/config';

/**
 * GET /api/cli/models
 *
 * Returns the model catalog from AppConfig so the CLI can render a
 * model picker. Falls back to an empty catalog if the AppConfig
 * doesn't restrict models (free-form input mode).
 */
export const GET = withCliAuth(async () => {
  const config = await getConfig();

  const catalog = config.models?.model_catalog ?? {};
  const entries = Object.entries(catalog).map(([id, spec]) => ({
    id,
    contextLimit: spec?.context_limit,
    maxOutputTokens: spec?.max_output_tokens,
    temperature: spec?.temperature,
  }));

  return Response.json({
    ok: true,
    defaultModel: config.models?.model ?? null,
    models: entries,
  });
});
