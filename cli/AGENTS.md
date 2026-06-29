# AGENTS.md — cli/

Compact guide for OpenCode sessions working in the `cli/` workspace. This is a separate Yarn Classic (`yarn@1.22.22`) monorepo from the root web app.

## Read first

- `cli/README.md` is the best map for the workspace boundaries and runtime flow.
- The CLI is a thin client: Web owns models, auth, tool routing, session persistence, and workflow execution.
- There is no direct provider mode; every model call goes through the Web backend.

## Commands

- Use Yarn Classic only in `cli/`; do not switch this workspace to Yarn Berry/PnP semantics.
- `yarn install` in `cli/` installs the workspace.
- `yarn build` builds packages in this order: `ai` → `agent` → `agentboster-adapter` → `coding-agent` (each `tsgo -p <pkg>/tsconfig.build.json`, plus asset copy in `coding-agent`); it is order-sensitive because later packages import earlier ones.
- `yarn check` runs `biome check --write --error-on-warnings . && tsgo --noEmit`; it **writes** (not read-only) and fails on warnings.
- `yarn bundle` produces `packages/coding-agent/dist/agentboster.cjs`; `yarn package` wraps it for distribution (`scripts/bundle.mjs`, `scripts/package.mjs`).
- Individual packages only expose `clean` (and `agentboster-adapter` exposes `build`); there is **no per-package `test` script** — run tests from the workspace root with `tsgo`/Vitest on the relevant `packages/*/test/**` paths.
- `agentboster --help` is the authoritative CLI flag list after a build.

## Package boundaries

- `packages/coding-agent` owns the `agentboster` binary, TUI, login flow, session management, and local tools.
- `packages/agentboster-adapter` owns stored auth, remote model lookup, and Web stream plumbing.
- `packages/agent` contains the agent loop primitives.
- `packages/ai` is the type surface and compatibility layer; it intentionally does not ship provider SDKs.

## CLI-specific gotchas

- `agentboster login` writes `~/.agentboster/config.json`; login is required before normal use.
- The model catalog comes from the Web backend, so selecting an unknown model should fail fast.
- `--print` skips the TUI and writes only final output to stdout.
- Keep changes aligned with Node `>=22.19.0` and the Yarn Classic workspace scripts in `cli/package.json`.
- Package cross-imports must use the `tsconfig.json` path aliases (`@agentboster-cli/ai`, `@agentboster-cli/agent`, `@agentboster-cli/core`, `@agentboster/adapter`), not deep relative paths; the build (`tsgo -p tsconfig.build.json`) relies on them.
- `tsconfig.json` only includes `packages/*/src/**` and `packages/*/test/**` (plus `coding-agent/examples/**`); files outside those globs are not typechecked by `yarn check`.
