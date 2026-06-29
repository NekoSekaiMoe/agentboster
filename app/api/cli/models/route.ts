import { withCliAuth } from '@/lib/cli/auth';
import { getConfig } from '@/lib/core/kv/config';
import {
  resolveModelContextLimit,
  resolveModelMaxOutputTokens,
} from '@/lib/workflow/agent/utils/model-context';

/**
 * GET /api/cli/models
 *
 * Returns the model catalog from AppConfig so the CLI can render a
 * model picker. Falls back to an empty catalog if the AppConfig
 * doesn't restrict models (free-form input mode).
 *
 * `contextLimit` / `maxOutputTokens` use the same resolution hierarchy as
 * the Web workflow / IM path (resolveMainAgentModelParams): catalog
 * override → global config.models.* → built-in per-model table → flat
 * fallback. Without this the CLI only saw catalog-or-128k and diverged
 * from the Web/IM context-window for any model not explicitly listed.
 */
export const GET = withCliAuth(async () => {
  const config = await getConfig();

  const catalog = config.models?.model_catalog ?? {};
  const globalContextLimit = config.models?.context_limit;
  const globalMaxOutputTokens = config.models?.max_output_tokens;
  const entries = Object.entries(catalog).map(([id, spec]) => ({
    id,
    contextLimit: resolveModelContextLimit(
      id,
      spec?.context_limit ?? globalContextLimit,
    ),
    maxOutputTokens: resolveModelMaxOutputTokens(
      id,
      spec?.max_output_tokens ?? globalMaxOutputTokens,
    ),
    temperature: spec?.temperature,
  }));

  return Response.json({
    ok: true,
    defaultModel: config.models?.model ?? null,
    models: entries,
  });
});
