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

export const clientSpoofEnum = z.enum(['off', 'on']);
export type ClientSpoof = z.infer<typeof clientSpoofEnum>;

/**
 * Provider compatibility overrides (borrowed from aionrs' ProviderCompat).
 *
 * Every field is optional; absent fields fall back to the defaults resolved
 * from the provider `format` (see lib/ai/provider-compat.ts). Set a field
 * explicitly to override the format default for that one flag.
 */
export const providerCompatSchema = z.object({
  /** Merge consecutive assistant messages (text concat + tool_calls merge). */
  merge_assistant_messages: z.boolean().optional(),
  /** Remove tool_result parts with no matching tool_call. */
  clean_orphan_tool_results: z.boolean().optional(),
  /** Remove tool_call parts with no matching tool_result. */
  clean_orphan_tool_calls: z.boolean().optional(),
  /** Deduplicate tool results with the same tool_call_id (keep last). */
  dedup_tool_results: z.boolean().optional(),
  /** Ensure messages alternate user/assistant (insert filler if needed). */
  ensure_alternation: z.boolean().optional(),
  /** Merge consecutive same-role messages into one. */
  merge_same_role: z.boolean().optional(),
});

export type ProviderCompatOverrides = z.infer<typeof providerCompatSchema>;

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
  client_spoof: clientSpoofEnum
    .default('off')
    .optional()
    .describe(
      'When "on", the tool impersonates the native client of each provider port: Codex for OpenAI (Responses only, not Legacy), Claude Code for Anthropic, Antigravity for Google (Gemini). "off" by default. Experimental.',
    ),
  /**
   * Message/tool normalization overrides (aionrs ProviderCompat). The AI
   * SDK already handles transport-level wire shape; these flags control the
   * *logical* shape of the accumulated message history sent to the model
   * (orphan tool-call cleanup, assistant merge, alternation, ...). Defaults
   * are resolved from `format`; override individual flags here.
   */
  compat: providerCompatSchema.optional(),
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
   * Phase 4 feature flag:启用 ContextPacker 优化模式(超预算丢弃 + 可观测 stats)。
   *
   * ⚠️ 全局 flag(final-review S3):非 per-user,多租户自托管下全实例生效。
   * env 与 config 任一为真即开(`MEMORY_PACKER_OPTIMIZE=1` 覆盖)。
   *
   * 默认 false = 严格等价于原 formatRecalledMemoriesForContext +
   * formatTriggeredMemoriesForContext 的拼接。设为 true 时,packer 在预算内丢弃
   * (各 block 内部,不跨源排序),减少 prompt 长度 + 提升 anti-lost-in-middle 效果。
   */
  memory_packer_optimize: z.boolean().optional(),
  /**
   * Phase 4 预算字符上限(final-review S4:从 context/index.ts 硬编码挪到 config)。
   * 默认 1800(中文 CJK 1 char=1 字,约 600-900 中文词)。
   * 仅在 memory_packer_optimize=true 时生效。
   *
   * reviewer D2:用 .min() 设一个能容纳 packWithBudget 固定头部开销(RECALL_HEADER ≈363 字符)
   * 的最小值,取代裸 positive() —— 预算过小会导致 recall 整块被丢光,配置无意义。
   */
  memory_packer_budget_chars: z
    .number()
    .int()
    .min(
      400,
      'memory_packer_budget_chars 必须不小于 400(容纳 RECALL_HEADER 开销)',
    )
    .optional(),
  /**
   * Phase 5 feature flag:启用知识库(knowledge)结果自动注入到对话 context。
   *
   * ⚠️ 全局 flag(final-review S3):非 per-user。env 与 config 任一为真即开
   * (`MEMORY_KNOWLEDGE_INJECT=1` 覆盖)。
   *
   * 默认 false = 知识库只能被 agent 显式调工具访问。
   * 设为 true 时,host 侧预取 knowledge 库搜索结果(collectRemoteMemoryItems),
   * 作为 Unverified 段进 recall block(不覆盖个人记忆)。
   */
  memory_knowledge_inject: z.boolean().optional(),
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
