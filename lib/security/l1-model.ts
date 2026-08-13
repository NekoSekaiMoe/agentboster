import type { AppConfig } from '@/types/config';

const DEFAULT_L1_SCORER_MODEL = 'openai/gpt-4o-mini';

export function resolveL1ScorerModelId(
  config: AppConfig,
  requestModelId?: string | null,
) {
  return (
    config.security?.l1_scorer_model?.trim() ||
    requestModelId?.trim() ||
    config.models?.model?.trim() ||
    DEFAULT_L1_SCORER_MODEL
  );
}
