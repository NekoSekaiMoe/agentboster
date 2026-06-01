import { z } from 'zod';

/**
 * MCP server configuration schema.
 */
export const mcpRemoteServerConfigSchema = z.object({
  type: z.enum(['http', 'sse']).default('http'),
  url: z.url('MCP server URL must be a valid URL'),
  headers: z.record(z.string(), z.string()).optional(),
});

export const builtinMcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type MCPRemoteServerConfig = z.infer<typeof mcpRemoteServerConfigSchema>;
export type BuiltinMcpServerConfig = z.infer<typeof builtinMcpServerConfigSchema>;

/**
 * MCP remote server map configuration schema.
 */
export const mcpRemotesServersConfigSchema = z
  .record(z.string(), mcpRemoteServerConfigSchema)
  .default({});

export const builtinMcpServersConfigSchema = z
  .record(z.string(), builtinMcpServerConfigSchema)
  .default({});

export type MCPRemoteServersConfig = z.infer<
  typeof mcpRemotesServersConfigSchema
>;

export type BuiltinMcpServersConfig = z.infer<
  typeof builtinMcpServersConfigSchema
>;

export const imageAnalyzeInputSchema = z.object({
  image_path: z.string().min(1),
  prompt: z.string().optional(),
  max_tokens: z.number().int().min(1).max(4096).optional().default(1024),
});

export const imageAnalyzeOutputSchema = z.object({
  description: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export type ImageAnalyzeInput = z.infer<typeof imageAnalyzeInputSchema>;
export type ImageAnalyzeOutput = z.infer<typeof imageAnalyzeOutputSchema>;
