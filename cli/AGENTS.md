# Repository Guidelines

## Project Structure & Module Organization
This is an npm workspaces monorepo under `packages/`.

- `packages/ai`: shared AI provider abstraction and model utilities.
- `packages/agent`: core agent primitives and orchestration.
- `packages/agentboster-adapter`: adapter layer for CLI agent runtime.
- `packages/tui`: terminal UI rendering primitives.
- `packages/coding-agent`: CLI application (`agentboster`), composed from the above packages.
- `scripts/`: build/package scripts for release workflows.
- `dist/` outputs are generated per package and should not be edited manually.

## Build, Test, and Development Commands
- `npm run build`: builds all packages in dependency order.
- `npm run clean`: runs package clean scripts.
- `npm run check`: runs formatting/linting/verification checks, including `tsgo --noEmit`.
- `npm run bundle`: creates distributable bundle artifacts.
- `npm run package`: packages release artifacts.
- Per package: run `npm run build`, `npm run test`, and `npm run clean` in the relevant `packages/*` folder.

## Coding Style & Naming Conventions
- TypeScript with native ESM (`"type": "module"`) and Node >= 22.19.0.
- Keep existing project style: 2-space indentation, semicolons, single quotes, trailing commas.
- Name files/functions/types descriptively and package-scoped.
- Use Biome as the formatter/linter; avoid mixing additional formatters.
- Prefer existing import style and avoid large import rewrites.

## Testing Guidelines
- Test framework is Vitest in core packages (`npm run test`).
- TUI-specific modules use Node test (`node --test`) in their package.
- Keep tests adjacent to changed behavior and prioritize regression coverage for CLI commands, parsing, and workflow paths.

## Commit & Pull Request Guidelines
Recent commits use Conventional Commits (e.g., `feat(cli): ...`, `fix(cli): ...`, `chore(cli): ...`).
- PRs should include a summary of changes and package scope.
- List verification steps and key outputs (`npm run check`, package tests).
- Note any behavior or CLI compatibility impact.

## Security & Configuration Tips
- Keep secrets out of source control; configure them via environment.
- Keep dependency changes intentional and review lockfile changes.
- For packaging-sensitive changes, verify release outputs before sharing artifacts.
