import { z } from 'zod';

import { aiModelConfigSchema } from './ai';

export const securityConfigSchema = z.object({
  /** L1 security scorer model. Overrides the model_id supplied by agentd when set. */
  l1_scorer_model: aiModelConfigSchema.optional(),
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;
