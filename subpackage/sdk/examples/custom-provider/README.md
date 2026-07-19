# @agentboster-example/custom-provider

Registers an OpenAI-compatible provider (local Ollama by default) so
its models appear in the model picker. Demonstrates `registerProvider`
/ `unregisterProvider`.

## What it shows

- **`pi.registerProvider(id, config)`** — adds a provider with one or
  more models. The runtime treats them like any built-in provider.
- **`ProviderConfig` shape** — `baseUrl`, `api` (one of `openai`,
  `anthropic`, etc.), `apiKey`, optional `authHeader`, and a `models`
  array with full cost / context-window metadata.
- **Cleanup on shutdown** — `pi.unregisterProvider(id)` in the
  `session_shutdown` hook. The host re-runs the factory on every
  reload, so unregistering prevents stale duplicates from accumulating.

## Install

```bash
cp -r . ~/.config/agentboster-cli/extensions/custom-provider/
# (Optional) edit config.json to override baseUrl or model list.
```

## Verify

1. Start Ollama locally: `ollama serve` and pull a model:
   `ollama pull llama3.1:8b`.
2. Launch the agentboster CLI in a project.
3. Open the model picker — you should see "Llama 3.1 8B (local)" and
   "Qwen 2.5 Coder 7B (local)".

## Adapting to other OpenAI-compatible servers

- **LM Studio**: change `DEFAULT_BASE_URL` to `http://127.0.0.1:1234/v1`.
- **vLLM**: change to your server's URL (commonly `http://127.0.0.1:8000/v1`).
- **llama.cpp server**: change to `http://127.0.0.1:8080/v1`.
- **GitHub Models / Together / Groq / OpenRouter**: set `apiKey` to
  your real key (or `$ENV_VAR` / `${ENV_VAR}` for env interpolation),
  enable `authHeader: true`, and set `baseUrl` to the appropriate
  endpoint.

## Token accounting

`cost` is in USD per token. Local models use 0 across the board;
tracked usage will show $0.00 even though tokens are still counted.
For paid providers, populate realistic values so the runtime's
context-compaction heuristics work correctly.
