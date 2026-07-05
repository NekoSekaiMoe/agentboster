# Repository Guidelines

## Project Structure & Module Organization

This directory is a Yarn Classic monorepo for the `agentboster` CLI. The root
`package.json` manages workspaces under `packages/`:

- `packages/ai`: shared AI type surface and compatibility stubs.
- `packages/agent`: agent loop and session primitives.
- `packages/agentboster-adapter`: auth, remote model lookup, Web streaming, and
  AgentBoster backend integration.
- `packages/coding-agent`: `agentboster` binary, TUI, local tools, extensions,
  session handling, and HTML export.
- `packages/desktop`: separate Tauri desktop app; it is not part of the root
  Yarn workspace list.

Runtime assets live with their consumers, for example
`packages/coding-agent/src/modes/interactive/assets/` and
`packages/coding-agent/src/modes/interactive/theme/`.

## Build, Test, and Development Commands

- `yarn install`: install dependencies with Yarn 1.x.
- `yarn build`: build workspace packages in dependency order with `tsgo` and copy
  CLI runtime assets.
- `yarn check`: run Biome with writes enabled and then `tsgo --noEmit`; review
  generated edits before committing.
- `yarn bundle`: create `packages/coding-agent/dist/agentboster.cjs`.
- `yarn package`: create the distributable CLI tarball.
- `yarn clean`: remove package `dist/` outputs.
- `yarn workspace @agentboster-cli/core test`: run the coding-agent Vitest suite.

After building, verify the CLI with
`node packages/coding-agent/dist/cli.js --help`.

## Coding Style & Naming Conventions

Use TypeScript ESM. Prefer workspace path aliases such as
`@agentboster-cli/agent` and `@agentboster/adapter` instead of deep relative
cross-package imports. Biome is the formatter and linter: 2-space indentation,
single quotes, semicolons, trailing commas, and 80-column formatting. Import
organization is disabled, so do not run separate import sorters.

Name source files descriptively in kebab case when adding new modules, matching
existing files such as `print-mode.ts` and `theme-controller.ts`.

## Testing Guidelines

Tests use Vitest. Place tests beside the relevant package under `packages/*/test/`
or use the existing `*.test.ts` pattern if introduced in a package. Run package
tests before changing shared behavior, and run `yarn check` before opening a PR.

## Commit & Pull Request Guidelines

Recent history mostly uses concise subjects with Conventional Commit prefixes,
for example `feat(workflow): ...` and `fix(ci): ...`; keep using
`type(scope): summary` when practical. Use imperative, specific summaries.

Pull requests should explain the behavior change, list validation commands run,
link related issues, and include screenshots or recordings for TUI or desktop UI
changes. Note any auth, config, or packaging impact.

## Security & Configuration Tips

The CLI is a thin client: model calls go through the Web backend, not local
provider SDKs. Do not commit tokens or `~/.agentboster/config.json` contents.
Node `>=22.19.0` is required.
