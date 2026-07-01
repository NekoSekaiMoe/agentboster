import { z } from 'zod';

import { aiModelConfigSchema } from './ai';

export const securityConfigSchema = z.object({
  /** L1 security scorer model. Overrides the model_id supplied by agentd when set. */
  l1_scorer_model: aiModelConfigSchema.optional(),
  /**
   * L1 score cache TTL in seconds. Low/medium verdicts for the same
   * command+context are served from KV without re-calling the LLM.
   * Defaults to 300 (5 min). Set to 0 to disable caching entirely.
   * high/critical verdicts are never cached regardless of this value.
   */
  l1_cache_ttl_seconds: z.number().int().min(0).optional(),
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;
