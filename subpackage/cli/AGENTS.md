# AGENTS.md — cli/

Compact guide for AI coding sessions working in the `cli/` workspace. This is a **Yarn Classic** (`yarn@1.22.22`) monorepo, separate from the root web app.

## Read first

- `cli/README.md` is the best map for workspace boundaries and runtime flow.
- The CLI is a thin client: Web owns models, auth, tool routing, session persistence, and workflow execution.
- There is no direct provider mode; every model call goes through the Web backend via `POST /api/cli/chat`.
- Based on [pi](https://github.com/earendil-works/pi) — legacy package names (`@earendil-works/pi-*`, `@mariozechner/pi-*`) appear in vitest alias maps but should not be used in new code.

## Toolchain

- **Node:** `>=22.19.0` (enforced via `engines`)
- **TypeScript:** `@typescript/native-preview` 7.0 (`tsgo`) for builds and type-checking; `typescript` 5.9 as fallback/IDE support.
- **Biome:** `2.3.5` — sole formatter/linter. `organizeImports` is off; do not run import sorters.
- **Vitest:** `4.1.9` for tests in all packages.
- **esbuild:** `0.28.1` for bundling.

## Commands

- `yarn install` — installs workspace. Use Yarn Classic only; do not switch to Berry/PnP.
- `yarn build` — builds in order: `ai` → `agent` → `agentboster-adapter` → `coding-agent` (each via `tsgo -p <pkg>/tsconfig.build.json`). Order-sensitive; later packages import earlier ones. Also `chmod +x` on CLI entry points and copies assets in `coding-agent`.
- `yarn check` — runs `biome check --write --error-on-warnings . && tsgo --noEmit`. Note: **writes** fixes (not read-only) and fails on warnings.
- `yarn bundle` — produces `packages/coding-agent/dist/agentboster.cjs` (single-file, assets inlined via esbuild).
- `yarn package` — wraps bundle into `agentboster-cli-<version>.tar.gz` (`scripts/package.mjs`).
- `yarn clean` — removes all `dist/` across workspace.

### Testing

- Per-package: each of `ai`, `agent`, `coding-agent` has `yarn test` → `vitest --run` with its own `vitest.config.ts`.
- `coding-agent`'s vitest config defines aliases for legacy pi package names so existing test imports resolve correctly.
- From root web repo: `yarn test subpackage/cli/packages/*/test/**` also works via the root vitest include glob.

## Package boundaries

| Package | npm name | Responsibility |
|---------|----------|----------------|
| `packages/ai` | `@agentboster-cli/ai` | Type surface + compat stubs (no provider SDKs) |
| `packages/agent` | `@agentboster-cli/agent` | Agent session/loop primitives |
| `packages/agentboster-adapter` | `@agentboster/adapter` | Stored auth, remote model lookup, Web stream, security eval, preferences, task summary |
| `packages/coding-agent` | `@agentboster-cli/core` | `agentboster` binary, TUI, login, sessions, local tools, extensions, export |

TUI is an **external** npm dependency (`@agentboster-cli/tui` → `npm:@earendil-works/pi-tui@0.80.2`), not a local package.

### Dependency graph (build order)

```
ai → agent → agentboster-adapter → coding-agent
                                         ↓
                                   @agentboster-cli/tui (npm)
```

## Package cross-imports

Must use `tsconfig.json` path aliases, not deep relative paths:

- `@agentboster-cli/ai`, `@agentboster-cli/ai/*`
- `@agentboster-cli/agent`, `@agentboster-cli/agent/*`
- `@agentboster-cli/core`, `@agentboster-cli/core/*`
- `@agentboster/adapter`, `@agentboster/adapter/*`
- `@agentboster-cli/tui`, `@agentboster-cli/tui/*`

The build (`tsgo -p tsconfig.build.json`) maps these to `dist/` paths; the root `tsconfig.json` (type-check only) maps them to `src/` for IDE navigation.

## coding-agent structure

```
src/
├── cli.ts              # entry point (bin)
├── rpc-entry.ts        # programmatic/RPC entry
├── main.ts             # app bootstrap
├── config.ts           # runtime config
├── cli/                # CLI arg parsing, login, startup
├── core/
│   ├── tools/          # local tool implementations (bash, edit, read, write, find, grep, ls, task, ...)
│   ├── extensions/     # extension system (loader, runner, types, wrapper)
│   ├── export-html/    # session HTML export
│   ├── compaction/     # context compaction
│   └── ...             # sessions, models, settings, skills, slash-commands, etc.
└── modes/
    ├── interactive/    # TUI mode (theme + assets)
    ├── print-mode.ts   # --print non-interactive output
    └── rpc/            # RPC/automation mode
```

## Adapter exports

Auth: `readStoredConfig`, `writeStoredConfig`, `getStoredAuth`, `clearStoredAuth`, `getAgentbosterHome`
Models: `fetchRemoteModels`, `remoteModelsToPiModels`
Streaming: `createAgentbosterStreamFn`, `openAgentbosterStream`
Security: `evaluateLocalCommand`, `formatToolRequest`
Preferences: `fetchUserPreferences`, `patchUserPreferences`
Task summary: `fetchTaskSummary`, `patchTaskSummary`

## Gotchas

- `yarn check` **writes** formatted output to disk; CI should run it and fail if the working tree is dirty afterward.
- `tsconfig.json` includes `packages/coding-agent/examples/**/*` but excludes `packages/coding-agent/examples/extensions/gondolin/**`. No `examples/` dir currently exists — this is future-proofing.
- Biome `files.includes` scopes to `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts`, and `packages/coding-agent/examples/**/*.ts`; it explicitly excludes `**/test-sessions.ts`, `**/models.generated.ts`, and `**/*.models.ts`.
- `agentboster login` writes `~/.agentboster/config.json`; login is required before any use.
- The model catalog comes from the Web backend; selecting an unlisted model fails fast.
- `--print` skips the TUI and writes only final output to stdout.
- `--yolo` auto-approves all `local_*` tool invocations without security scoring.
- `rpc-entry.js` is marked executable at build time for editor/automation integrations.
- `husky` is in devDependencies with a `prepare` script, but no `.husky/` directory exists yet — pre-commit hooks are not currently active.
- The `coding-agent` vitest config aliases old upstream names (`@earendil-works/pi-*`, `@mariozechner/pi-*`) to local sources; these should not appear in new code.
