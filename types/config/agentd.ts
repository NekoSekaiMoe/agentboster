import { z } from 'zod';

export const agentdConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

export type AgentdConfig = z.infer<typeof agentdConfigSchema>;
