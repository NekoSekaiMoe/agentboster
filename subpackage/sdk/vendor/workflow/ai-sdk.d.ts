// Minimal stub for the Vercel AI SDK types referenced by types/workflow.ts.
//
// The SDK re-declares every workflow type locally (see src/workflow/*)
// instead of importing from `types/workflow.ts`, because the `@/types`
// alias is not resolvable outside the Web tier. This stub exists only
// to let future per-file copies of upstream types compile when they
// keep their `import type { UIMessage } from 'ai'` line — it is wired
// up via tsconfig.json `paths` (the SDK owner maps `'ai'` here).
//
// REGEN: when types/workflow.ts adds new ai-sdk imports, extend this
// stub to match. Each stub is intentionally permissive (`unknown` /
// minimal structural shape) so the runtime — which sees the real
// `ai` module — can substitute the proper type at load time.
//
// Source: types/workflow.ts (imports line), lib/workflow/agent/hooks/types.ts

export interface UIMessage<
  TMetadata = unknown,
  TDataParts = Record<string, unknown>,
> {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: TMetadata;
  data?: unknown;
  [key: string]: unknown;
}

export interface UIMessageChunk<
  TMetadata = unknown,
  TDataParts = Record<string, unknown>,
> {
  type: string;
  metadata?: TMetadata;
  data?: unknown;
  [key: string]: unknown;
}

export interface StepResult<TToolSet = unknown> {
  id?: string;
  role?: string;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: number;
  };
  finishReason?: string;
  warnings?: unknown[];
  [key: string]: unknown;
}

export type ToolSet = Record<string, unknown>;

export type LanguageModelUsage = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: number;
};

// `ModelMessage` is a deep union of role-tagged message shapes from the
// AI SDK. The SDK only uses it as a pass-through payload (initial
// workflow messages), so `unknown` is safe here.
export type ModelMessage = unknown;

// `LanguageModelV3Prompt` mirrors `@ai-sdk/provider`. Same treatment.
export type LanguageModelV3Prompt = unknown;
