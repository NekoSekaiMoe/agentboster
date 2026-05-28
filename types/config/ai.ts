import { z } from 'zod';

export const aiProviderEnum = z.enum([
  'openaicompatible',
  'anthropic',
  'openai',
  'google',
]);

export type AIProvider = z.infer<typeof aiProviderEnum>;

/**
 * AI provider configuration schema.
 */
export const aiProviderConfigSchema = z.object({
  format: aiProviderEnum,
  api_key: z.string().optional().describe('API key can be configured via env.'),
  base_url: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  preset: z.string().optional().describe('Provider preset key (e.g., openai, anthropic, deepseek, ollama). When set, base_url and format are auto-filled.'),
});

export type AIProviderConfig = z.infer<typeof aiProviderConfigSchema>;

/**
 * AI model identifier schema.
 *
 * Accepts two formats:
 * - Scoped: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o")
 * - Bare: "model-id" (e.g. "deepseek-chat", "stepfun-3.5-flash") — resolved against the
 *   first configured provider at runtime. Preferred for OpenAI Compatible providers whose
 *   base URL already implies the provider.
 */
export const aiModelConfigSchema = z
  .string()
  .min(1, 'Model ID must not be empty');

export type AIModelConfig = z.infer<typeof aiModelConfigSchema>;

/**
 * AI global configuration schema.
 */
export const aiConfigSchema = z.object({
  /** Global default temperature (0.0 - 2.0), controls output randomness. */
  temperature: z
    .number()
    .min(0, 'Temperature must be >= 0')
    .max(2, 'Temperature must be <= 2')
    .default(0.7),
  /** Default model ID. Supports "provider/model-id" or bare model names (see aiModelConfigSchema). */
  model: aiModelConfigSchema,
  /** Embedding model ID. Supports "provider/model-id" or bare model names (see aiModelConfigSchema). */
  embedding_model: aiModelConfigSchema.optional(),
  /** Default context length limit (tokens). */
  context_limit: z
    .number()
    .int()
    .min(1, 'Context limit must be > 0')
    .optional(),
  /** Default max output length limit (tokens). */
  max_output_tokens: z
    .number()
    .int()
    .min(1, 'Output limit must be > 0')
    .optional(),
  providers: z
    .record(z.string(), aiProviderConfigSchema)
    .default({})
    .optional(),
});

export type AIConfig = z.infer<typeof aiConfigSchema>;
