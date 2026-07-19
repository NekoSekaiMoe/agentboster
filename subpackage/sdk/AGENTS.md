# AGENTS.md — subpackage/sdk/

Public SDK package for building agentboster extensions, skills, prompts,
and themes. Re-exports types from `@agentboster-cli/core` plus carries
canonical docs and a reference extension example.

## Layout

- `src/index.ts` — public type + helper re-exports.
- `src/compat.ts` — cross-runtime-version helpers (`resolveModelApiKey`).
- `docs/` — canonical docs migrated from `cli/packages/desktop/docs/`:
  `PACKAGES.md`, `CAPABILITY_MODEL.md`, `PACKAGE_CAPABILITY_TEMPLATE.md`,
  `ARCHITECTURE.md`. The Desktop-specific docs (ICONS, PERMISSIONS,
  THEMES_DESKTOP_MAPPING, RELEASES) stayed in `desktop/docs/`.
- `examples/hello-tool/` — minimal extension: tool + command + lifecycle
  hook. Also serves as a smoke test for the loader.
- `README.md` — author-facing intro.

## Module

Standalone npm package (`@agentboster/sdk`). NOT part of the
`cli/` Yarn workspace — install it independently. Ships as TypeScript
source (the runtime compiles extensions via jiti), so there is no build
step.

## Toolchain

| Tool | Purpose |
|---|---|
| TypeScript (target ES2022, module ESNext, moduleResolution Bundler) | type-check |
| Biome 2.x | formatter/linter (matches root) |

## Commands

```bash
yarn install              # or npm install
yarn run check:lint       # tsc --noEmit
```

There is no `build` script — the SDK is consumed as `.ts` source.

## Conventions

- **Re-exports, not copies.** Types in `src/index.ts` come from
  `@agentboster-cli/core`. Don't duplicate type definitions here; if a
  type is missing, add it to the runtime's `core/extensions/types.ts`
  and re-export. This keeps the SDK a curated view, not a fork.
- **Manifest namespace.** Document both `agentboster` (current) and
  `pi` (legacy) in examples. The runtime accepts both; new docs prefer
  `agentboster`.
- **No host-only APIs.** Anything that requires desktop UI / Tauri /
  Node `fs` does NOT belong in the SDK. The SDK targets the
  runtime-agnostic extension surface.
- **Helpers go in `src/compat.ts`.** Cross-version helpers (shims for
  API changes between runtime versions) live there. Don't inline them
  in examples.

## Adding new public types

1. Add the type to `cli/packages/coding-agent/src/core/extensions/types.ts`
   (the source of truth).
2. Re-export from `cli/packages/coding-agent/src/core/extensions/index.ts`
   and (if it's truly public) from `coding-agent/src/index.ts`.
3. Add the re-export to `sdk/src/index.ts`.
4. If it has a cross-version compatibility story, add a helper in
   `sdk/src/compat.ts`.
5. Document in `sdk/docs/PACKAGE_CAPABILITY_TEMPLATE.md` if it's part
   of the recommended authoring flow.

## Docs sync

When `desktop/docs/PACKAGES.md` or related docs change, update the copy
in `sdk/docs/` too. The Desktop copies are kept as the "applied" view
(desktop-specific examples inline); the SDK copies are the canonical
generic version. Prefer editing the SDK version and let Desktop follow.
