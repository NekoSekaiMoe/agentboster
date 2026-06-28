# AGENTS.md — cli/

Compact guide for OpenCode sessions working in the `cli/` workspace. This is a separate Yarn Classic (`yarn@1.22.22`) monorepo from the root web app.

## Read first

- `cli/README.md` is the best map for the workspace boundaries and runtime flow.
- The CLI is a thin client: Web owns models, auth, tool routing, session persistence, and workflow execution.
- There is no direct provider mode; every model call goes through the Web backend.

## Commands

- Use Yarn Classic only in `cli/`; do not switch this workspace to Yarn Berry/PnP semantics.
- `yarn install` in `cli/` installs the workspace.
- `yarn build` builds packages in this order: `ai` → `agent` → `agentboster-adapter` → `coding-agent`.
- `yarn check` runs `biome check --write --error-on-warnings . && tsgo --noEmit`; it is not read-only.
- `yarn bundle` creates `dist/agentboster.cjs` for the CLI package.
- `yarn workspace <pkg> test` exists on individual packages such as `packages/agent`, `packages/ai`, and `packages/coding-agent`.
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
