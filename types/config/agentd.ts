import { z } from 'zod';

export const agentdNodeSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  name: z.string().optional(),
});

export const agentdConfigSchema = z.object({
  enabled: z.boolean().default(false),
  nodes: z.array(agentdNodeSchema).default([]),
  follow_up_enabled: z.boolean().default(false),
});

export type AgentdNode = z.infer<typeof agentdNodeSchema>;
export type AgentdConfig = z.infer<typeof agentdConfigSchema>;
