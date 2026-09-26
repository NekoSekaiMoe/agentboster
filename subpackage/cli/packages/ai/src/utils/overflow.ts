import type { AssistantMessage } from '../types.ts';

/**
 * Regex patterns to detect context overflow errors from different providers,
 * ported from pi-ai 0.87.1 (`utils/overflow.ts`). The thin-client CLI sees the
 * backend-proxied provider error text, so the same message-matching applies
 * wherever the web backend passes the original error string through.
 */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN =
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server
 * errors). Error messages matching any of these are excluded from overflow
 * detection even if they also match an OVERFLOW_PATTERN.
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * Handles error-based overflow (detectable message patterns), silent overflow
 * (usage.input + cacheRead exceeds the context window on a normal stop), and
 * length-stop overflow (zero output with input + cacheRead at least 99% of
 * the window). Omitting contextWindow, or passing zero, disables usage checks.
 * Recognized throttling messages are excluded from error-pattern matching.
 * @param contextWindow Model context capacity in tokens.
 */
export function isContextOverflow(
  message: AssistantMessage,
  contextWindow?: number,
): boolean {
  // Case 1: Check error message patterns
  if (message.stopReason === 'error' && message.errorMessage) {
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) =>
      p.test(message.errorMessage as string),
    );
    if (!isNonOverflow) {
      if (
        OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage as string))
      ) {
        return true;
      }
      if (
        message.provider === 'cerebras' &&
        CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message.errorMessage as string)
      ) {
        return true;
      }
    }
  }
  // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
  if (contextWindow && message.stopReason === 'stop') {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) {
      return true;
    }
  }
  // Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates
  // oversized input to fit the context window, leaving no room for output.
  if (
    contextWindow &&
    message.stopReason === 'length' &&
    message.usage.output === 0
  ) {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }
  return false;
}

/** Check whether a length stop ended below the intended output limit. */
export function isRecoverableLength(
  message: AssistantMessage,
  desiredMaxOutput: number,
): boolean {
  return (
    message.stopReason === 'length' &&
    desiredMaxOutput > 0 &&
    message.usage.output < desiredMaxOutput
  );
}

/** Get the overflow patterns for testing purposes. */
export function getOverflowPatterns(): RegExp[] {
  return [...OVERFLOW_PATTERNS];
}
