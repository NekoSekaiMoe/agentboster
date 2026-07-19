# @agentboster/sdk

Public SDK for building agentboster extensions, skills, prompts, and themes.

This package is the curated surface external authors should target. It
re-exports types and helpers from `@agentboster-cli/core` (the runtime),
plus carries the canonical docs and a working example extension.

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

## Quick start

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
| `src/index.ts` | Public type + helper re-exports |
| `src/compat.ts` | Cross-version helpers (`resolveModelApiKey`) |
| `docs/PACKAGES.md` | Philosophy: what belongs in an extension vs the host |
| `docs/CAPABILITY_MODEL.md` | The `extension_ui_request` capability whitelist |
| `docs/PACKAGE_CAPABILITY_TEMPLATE.md` | Step-by-step extension authoring guide + PR checklist |
| `docs/ARCHITECTURE.md` | Three-layer host model: Desktop → CLI → extensions |
| `examples/hello-tool/` | Reference extension (tool + command + lifecycle hook) |

## Manifest field

Use `agentboster` (current) or `pi` (legacy, still accepted):

```json
{ "agentboster": { "extensions": ["index.ts"] } }
```

If absent, the loader falls back to `index.ts` at the package root.

## Compatibility

This package ships as TypeScript source. The runtime (agentboster CLI)
compiles extensions on load via jiti, so there is no build step and no
dist output to keep in sync.

Target the version of `@agentboster/sdk` that matches your runtime
version. Within a major version, the public surface is additive.
