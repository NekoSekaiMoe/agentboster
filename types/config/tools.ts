import { z } from 'zod';

export const userTypeEnum = z.enum(['unknown', 'user', 'admin']);

export type UserType = z.infer<typeof userTypeEnum>;

export const toolConfigSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.string()).default({}),
  minUserType: userTypeEnum.optional(),
});

export const buildInToolConfigSchema = z
  .record(z.string(), toolConfigSchema)
  .default({});

export const toolCatalogItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  requiredConfig: z.array(z.string()).default([]),
  optionalConfig: z.array(z.string()).default([]),
  missingRequiredConfig: z.array(z.string()).default([]),
  canEnable: z.boolean(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.string()).default({}),
});

export const toolCatalogResponseSchema = z.object({
  tools: z.array(toolCatalogItemSchema).default([]),
});

export type BuiltInToolId = string;
export type ToolEntryConfig = z.infer<typeof toolConfigSchema>;
export type ToolConfig = z.infer<typeof buildInToolConfigSchema>;
export type ToolCatalogItem = z.infer<typeof toolCatalogItemSchema>;
export type ToolCatalogResponse = z.infer<typeof toolCatalogResponseSchema>;
