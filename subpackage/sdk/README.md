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

The SDK is organized into five surfaces. Each surface has a dedicated
subdirectory under `src/` and a regen script under `scripts/` that
detects drift against its source-of-truth tier.

| Surface | Covers | Source of truth | Maturity |
|---|---|---|---|
| **CLI runtime** (`src/cli/`) | Extensions, skills, prompts, themes, tool/agent primitives, session lifecycle. Re-exported from `@agentboster-cli/core`. Loaded by the CLI runtime via jiti. | `cli/packages/coding-agent/src/index.ts` | **Ready** |
| **Web HTTP API** (`src/web/`) | Auth (cookie / CLI token / agentd-key / signed URL), SSE event schemas, request/response shapes for `/api/cli/*` and `/api/agentd/v1/*` routes. | `lib/auth/`, `lib/cli/`, `app/api/cli/**`, `lib/security/` | **Ready** (core; route bodies expanding) |
| **Workflow DevKit** (`src/workflow/`) | `WorkflowUIMessageChunk` / `WorkflowStatusData`, hook payloads, message persistence shapes, dispatch facade types. | `types/workflow.ts`, `lib/workflow/agent/**`, `lib/chat/message-utils.ts` | **Ready** |
| **Desktop IPC & bridge** (`src/desktop/`) | Tauri `invoke` command map, RPC bridge messages, `AppSettings`, workspace state, tray/window events. | `subpackage/cli/packages/desktop/src-tauri/src/lib.rs`, `src/rpc/bridge.ts`, `src/main.ts` | **Ready** |
| **Agentd tool protocol** (`src/agentd/`) | `APIResponse<T>` envelope, tool exec / SSE stream, sandbox profiles, L0/L1/L2 security events, node register/heartbeat wire. | `subpackage/agentd/internal/clawless/types.go`, `internal/agent/*`, `internal/lifecycle/*` | **Ready** |

The CLI surface is re-exported flat at the package root for backwards
compatibility (extensions do `import { ExtensionAPI } from '@agentboster/sdk'`).
The other four surfaces are exported as namespaces
(`import { web, workflow, desktop, agentd } from '@agentboster/sdk'`) to
avoid name collisions with the flat CLI surface and to make call-site
intent clearer.

Everything ships as TypeScript source — there is no build step. The CLI
runtime compiles extensions on load via jiti; the other surfaces are
pure type re-exports consumed at type-check time.

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
| `src/index.ts` | Package entry — re-exports CLI flat + the four newer surfaces as namespaces |
| `src/cli/index.ts` | CLI runtime surface (re-export from `@agentboster-cli/core`; regen via `regen-cli`) |
| `src/web/` | Web HTTP API surface: `auth.ts`, `envelope.ts`, `sse.ts`, `routes.ts` |
| `src/workflow/` | Workflow DevKit surface: `chunks.ts`, `hooks.ts`, `messages.ts`, `dispatch.ts`, `types.ts` |
| `src/desktop/` | Desktop IPC surface: `settings.ts`, `invoke.ts`, `rpc.ts`, `events.ts`, `workspace.ts` |
| `src/agentd/` | Agentd protocol surface: `envelope.ts`, `tools.ts`, `sandbox.ts`, `security.ts`, `node.ts`, `paths.ts` |
| `src/compat.ts` | Cross-version helpers (`resolveModelApiKey`) |
| `vendor/core.d.ts` | CLI runtime type stub for standalone type-check |
| `vendor/workflow/ai-sdk.d.ts` | Minimal stub for the `ai` package referenced by Workflow chunks |
| `scripts/regen-*.py` | One regen script per surface — drift detectors that scan each surface's source-of-truth files and report mismatches against the SDK mirror |
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
version. Within a major version:

- The **CLI surface** is re-exported flat at the package root and stays
  additive (existing extensions keep working).
- The **Web / Workflow / Desktop / Agentd surfaces** are exported as
  namespaces and may gain new types between minor versions; existing
  types are additive only.
- Each surface has a regen script (`scripts/regen-<surface>.py`) that
  reports drift against its source-of-truth tier — run them in CI to
  catch unmirrored changes.
