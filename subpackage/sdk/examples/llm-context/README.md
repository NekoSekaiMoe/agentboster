# @agentboster-example/llm-context

Extension that summarizes the current session conversation by calling
a provider directly with `fetch`. Demonstrates the canonical pattern
for extensions that need their own LLM call (advisors, linters,
auto-namers, summarizers, …).

## What it shows

- **`buildSessionContext`** — assemble the runtime's canonical
  conversation representation from the active session.
- **`convertToLlm`** — turn it into the OpenAI-style `messages` array
  most providers accept.
- **`resolveModelApiKey`** — the cross-runtime-version shim for getting
  the API key. Prefer this over reaching into `ctx.modelRegistry`
  directly; older runtimes only expose `getApiKey`, current ones expose
  `getApiKeyAndHeaders`.
- **Calling the provider with `fetch`** — agentboster is a thin client
  (no local provider SDK is bundled), so any LLM call from an extension
  is a plain HTTP request.

## Install

```bash
cp -r . ~/.config/agentboster-cli/extensions/llm-context/
```

## Verify

Ask the model:

> Use summarize_conversation to recap what we've done.

You should get a one-paragraph summary.

## Caveats

- The example assumes the provider speaks OpenAI Chat Completions
  (`POST /v1/chat/completions`). For Anthropic-native endpoints, hit
  `/v1/messages` with the Anthropic payload shape.
- The conversation is sent verbatim (only a system instruction is
  prepended). For long sessions, trim or rely on the host's compaction
  before this tool is invoked.
- The `model` object is structurally inspected (`baseUrl`, `id`). Real
  extensions should consume the typed `Model` from `@agentboster/sdk`
  once the runtime injects the real shape; the SDK's standalone stub
  types it as `any`.
