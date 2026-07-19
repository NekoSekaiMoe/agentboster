/**
 * Custom provider example extension.
 *
 * Demonstrates how to:
 *   1. Register a custom OpenAI-compatible provider via `pi.registerProvider`
 *      so users can pick it from the model selector and call /login.
 *   2. Define models with full cost / context-window metadata so the
 *      runtime accounts for them correctly in compaction + token usage.
 *   3. Clean up via `pi.unregisterProvider` (the host re-runs the
 *      factory on reload, so unregistering prevents stale duplicates).
 *
 * The example targets a local Ollama server. The same pattern works
 * for LM Studio, vLLM, llama.cpp's OpenAI-compatible server, or any
 * provider that speaks the OpenAI Chat Completions protocol.
 *
 * Users select the registered models from the in-app model picker
 * (no extension restart needed).
 */

import type { ExtensionAPI, ProviderConfig } from '@agentboster/sdk';

const PROVIDER_ID = 'ollama-local';

// Defaults; users can edit `~/.config/agentboster-cli/config.json` to
// override baseUrl or pick different model IDs.
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

const MODELS = [
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 8B (local)',
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder 7B (local)',
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  },
];

export default function ollamaProvider(pi: ExtensionAPI): void {
  const config: ProviderConfig = {
    name: 'Ollama (local)',
    baseUrl: DEFAULT_BASE_URL,
    // Ollama doesn't require an API key, but the runtime insists on a
    // non-empty value. Use a sentinel — the host won't validate it.
    apiKey: 'ollama',
    api: 'openai',
    authHeader: false,
    models: MODELS,
  };

  pi.registerProvider(PROVIDER_ID, config);

  // The host calls the factory on every reload (config edit, restart,
  // session switch into the project). If we don't unregister, every
  // reload appends a duplicate provider entry. The runtime keeps the
  // last registration for a given id, so unregister-first-then-register
  // is the safe pattern.
  //
  // (Cleanup isn't strictly required for one-shot extensions; this is
  // the production-grade pattern.)
  pi.on('session_shutdown', () => {
    pi.unregisterProvider(PROVIDER_ID);
  });
}
