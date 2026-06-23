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
  /**
   * Long-term memory recall strategy.
   *
   * - 'vector': hybrid vector + keyword search. Requires `embedding_model`
   *   to be configured; falls back to keyword-only when it's missing.
   * - 'scorer': LLM-based relevance scoring. Works without an embedding
   *   model — each new message triggers one small-LLM call to judge which
   *   stored memories are useful for the reply. Costs one extra LLM call
   *   per message but produces stable semantic recall for deployments
   *   where users typically don't configure an embedding model.
   *
   * When unset, the runtime resolves the effective strategy:
   *   `embedding_model` configured → 'vector', otherwise → 'scorer'.
   *   This protects existing users from a behavior change while giving
   *   new users (who usually skip embedding) sane defaults.
   */
  memory_recall_strategy: z.enum(['vector', 'scorer']).optional(),
  /**
   * Cross-encoder reranker configuration.
   *
   * When enabled, the 'vector' recall strategy inserts a dedicated
   * cross-encoder rerank pass between RRF fusion and the top-K cut. This
   * is cheaper and finer-grained than LLM-as-reranker (the 'scorer'
   * strategy): a single small HTTP call to a dedicated relevance model
   * (Qwen3-Reranker-8B, bge-reranker-v2-m3, Jina/Cohere rerank APIs, …)
   * outputs continuous relevance scores in ~300ms-3s with zero token
   * cost. The 'scorer' strategy already uses an LLM for precision
   * ranking, so cross-rerank is not applied there to avoid double cost.
   *
   * All failure modes are fail-open: network errors, malformed
   * responses, and short candidate pools return the RRF order unchanged.
   */
  cross_rerank: z
    .object({
      enabled: z.boolean().default(false),
      /** Provider preset for protocol selection. */
      protocol: z.enum(['jina', 'dashscope']).default('jina'),
      /** Model id, e.g. "Qwen3-Reranker-8B" / "bge-reranker-v2-m3". */
      model: z.string().optional(),
      /** Base URL of the rerank HTTP service. */
      api_url: z.string().optional(),
      /** Bearer token for the rerank service. */
      api_key: z.string().optional(),
      /** Number of candidates to keep after reranking. Default = topK of the recall call. */
      top_n: z.number().int().min(1).optional(),
      /** Request timeout in seconds. Default 10. */
      timeout_seconds: z.number().min(1).max(60).default(10),
    })
    .optional(),
  /**
   * @deprecated Alias kept for backward compatibility — prefer setting
   * `cross_rerank.enabled` via the structured object above. When this
   * scalar is `true` and `cross_rerank` is absent, the runtime still
   * honors it by constructing a default object.
   */
  cross_rerank_enabled: z.boolean().optional(),
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
