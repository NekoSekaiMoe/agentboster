import { z } from 'zod';

export const aiProviderEnum = z.enum([
  'openaicompatible',
  'anthropic',
  'openai',
  'google',
]);

export type AIProvider = z.infer<typeof aiProviderEnum>;

/**
 * Which OpenAI-style HTTP endpoint to use when format === 'openai'.
 *
 * Background: @ai-sdk/openai's createOpenAI() defaults to the Responses
 * API (/v1/responses). Third-party OpenAI-compatible endpoints (GLM,
 * DeepSeek via openai format, Azure OpenAI, etc.) typically only implement
 * the Chat Completions API (/v1/chat/completions) and return malformed
 * tool_calls when sent Responses-format requests.
 *
 * - 'responses' : always use /v1/responses (official OpenAI only)
 * - 'chat'      : always use /v1/chat/completions (max compatibility)
 * - 'auto'      : decide at runtime based on base_url — official OpenAI
 *                 uses 'responses', everything else uses 'chat'
 *
 * Ignored when format !== 'openai'.
 */
export const openaiApiEnum = z.enum(['responses', 'chat', 'auto']);
export type OpenAiApi = z.infer<typeof openaiApiEnum>;

/**
 * AI provider configuration schema.
 */
export const aiProviderConfigSchema = z.object({
  format: aiProviderEnum,
  api_key: z.string().optional().describe('API key can be configured via env.'),
  base_url: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  preset: z
    .string()
    .optional()
    .describe(
      'Provider preset key (e.g., openai, anthropic, deepseek, ollama). When set, base_url and format are auto-filled.',
    ),
  openai_api: openaiApiEnum
    .default('auto')
    .optional()
    .describe(
      'Which OpenAI API endpoint to use when format=openai. "auto" picks "responses" for the official OpenAI base_url and "chat" for everything else.',
    ),
});

export type AIProviderConfig = z.infer<typeof aiProviderConfigSchema>;

/**
 * AI model identifier schema.
 *
 * Accepts two formats:
 * - Scoped: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o")
 * - Bare: "model-id" (e.g. "deepseek-chat", "stepfun-3.5-flash") — resolved against the
 *   first configured provider at runtime. Preferred for OpenAI Legacy providers whose
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
    .default(0.5),
  /** Default model ID. Supports "provider/model-id" or bare model names (see aiModelConfigSchema). */
  model: aiModelConfigSchema.optional(),
  /**
   * Per-model catalog of parameter overrides. Keys are model IDs
   * ("provider/model-id" or bare, same format as `model`). Values are
   * partial overrides — any field left `undefined` falls back to the
   * top-level `temperature` / `context_limit` / `max_output_tokens`.
   *
   * The set of keys also serves as the "allowed models" list surfaced
   * to users in the chat-box picker. An empty object (`{}`) means
   * "whitelist this model but use global defaults for all parameters".
   *
   * Not enforced server-side — this is a UI hint, not an authorization
   * boundary; free-form model input remains allowed.
   */
  model_catalog: z
    .record(
      z.string(),
      z.object({
        temperature: z.number().min(0).max(2).optional(),
        context_limit: z.number().int().min(1).optional(),
        max_output_tokens: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
  /** Embedding model ID. Supports "provider/model-id" or bare model names (see aiModelConfigSchema). */
  embedding_model: aiModelConfigSchema.optional(),
  /** Default context length limit (tokens). */
  context_limit: z
    .number()
    .int()
    .min(1, 'Context limit must be > 0')
    .default(200000),
  /** Default max output length limit (tokens). */
  max_output_tokens: z
    .number()
    .int()
    .min(1, 'Output limit must be > 0')
    .default(65536),
  providers: z
    .record(z.string(), aiProviderConfigSchema)
    .default({})
    .optional(),
});

export type AIConfig = z.infer<typeof aiConfigSchema>;
