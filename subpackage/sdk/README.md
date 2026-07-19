# @agentboster/sdk

Public SDK for the AgentBoster platform. It unifies the **public types and
contracts across the three deployable tiers** — CLI, Web, and Desktop — into
one curated surface external authors and integration code can target.

## Scope: a cross-tier SDK

AgentBoster is split into three independently deployable parts (Web, agentd,
CLI/Desktop). The SDK is the single place where their public contracts meet,
so that:

- extension / skill / prompt / theme authors target one package regardless of
  which tier their code runs in;
- integrators calling the Web HTTP API from a separate process (an agentd
  sidecar, a backend service, a CI script) get typed request/response shapes
  instead of hand-rolled fetch bodies;
- tool / sandbox authors writing for agentd (or a third-party execution node)
  share the same protocol types as the daemon itself.

The SDK is organized into five surfaces. Each surface has a maturity level —
**ready** (re-exported today, locked within a major version) or **roadmap**
(types still being sourced; safe to depend on but expect churn).

| Surface | Covers | Maturity |
|---|---|---|
| **CLI runtime** | Extensions, skills, prompts, themes, tool/agent primitives, session lifecycle. Re-exported from `@agentboster-cli/core`. Loaded by the CLI runtime via jiti. | **Ready** |
| **Web HTTP API** | Request/response shapes for `/api/cli/*`, `/api/agentd/v1/*`, auth (cookie / CLI token / agentd-key / signed URL), event schemas (chat stream, session-events SSE, subagent stream). | Roadmap |
| **Workflow DevKit** | Step definitions, event persistence, hook builders, run identity — so external schedulers and tests can construct/resume workflow runs against the Web runtime. | Roadmap |
| **Desktop IPC & bridge** | Tauri `invoke` command contracts, RPC bridge messages (Desktop ↔ CLI `--mode rpc`), pane/workspace state shapes, settings schema (`close_action`, `screenshot_format`, etc.). | Roadmap |
| **Agentd tool protocol** | Tool exec envelope (`{ success, data, error }`), sandbox profiles (`docker` / `docker-strict` / `lxc`), L0/L1/L2 event schema, node registration & heartbeat shapes. | Roadmap |

Everything ships as TypeScript source — there is no build step. The CLI
runtime compiles extensions on load via jiti; other surfaces are pure type
re-exports consumed at type-check time.

## Install

```
npm install @agentboster/sdk
```

(or `yarn add`, `pnpm add`, etc.)

Peer dependencies (`@agentboster-cli/core`, `typebox`) are optional at
type-check time but must be available in the host runtime when the
extension is loaded. The runtime injects them via virtual-module
aliases, so extensions just `import { Type } from 'typebox'` and
`import type { ExtensionAPI } from '@agentboster/sdk'`.

## Quick start (CLI extension)

```ts
// index.ts — your extension's default export
import { Type } from 'typebox';
import type { ExtensionAPI } from '@agentboster/sdk';

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ping',
    label: 'Ping',
    description: 'Reply with pong.',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'pong' }] };
    },
  });
}
```

```json
// package.json
{
  "name": "@you/ping",
  "type": "module",
  "main": "index.ts",
  "agentboster": { "extensions": ["index.ts"] },
  "dependencies": { "@agentboster/sdk": "^0.1.0", "typebox": "^1.0.0" }
}
```

Drop the package into `~/.config/agentboster-cli/extensions/` and start
the CLI — the runtime discovers and loads it via jiti.

## What's in this package

| Path | What |
|---|---|
| `src/index.ts` | Public type + value re-exports (CLI surface today; other surfaces land here as they mature) |
| `src/compat.ts` | Cross-version helpers (`resolveModelApiKey`) |
| `vendor/core.d.ts` | Minimal type stub for standalone SDK type-check |
| `scripts/regen-stubs.py` | Regenerate `vendor/core.d.ts` from the runtime's exports |
| `scripts/regen-exports.py` | Regenerate `src/index.ts` explicit export list |
| `docs/ARCHITECTURE.md` | AgentBoster tier model and how the SDK maps onto it |
| `docs/PACKAGES.md` | Philosophy: what belongs in an extension vs the host |
| `docs/CAPABILITY_MODEL.md` | The `extension_ui_request` capability whitelist |
| `docs/PACKAGE_CAPABILITY_TEMPLATE.md` | Step-by-step extension authoring guide + PR checklist |
| `examples/hello-tool/` | Minimal tool + command + lifecycle hook |
| `examples/llm-context/` | Read session context, call a provider via fetch |
| `examples/custom-provider/` | Register an OpenAI-compatible provider (Ollama) |
| `examples/ui-capabilities/` | Shortcuts, flags, message renderers, status line |
| `examples/commands-and-hooks/` | Slash command patterns + 4 lifecycle hooks |

## Manifest field

Use `agentboster` (current) or `pi` (legacy, still accepted):

```json
{ "agentboster": { "extensions": ["index.ts"] } }
```

If absent, the loader falls back to `index.ts` at the package root.

## Compatibility

This package ships as TypeScript source. The CLI runtime compiles
extensions on load via jiti, so there is no build step and no dist output
to keep in sync.

Target the version of `@agentboster/sdk` that matches your runtime
version. Within a major version, the **ready** surface is additive; the
**roadmap** surfaces may move between minor versions until they stabilize.
