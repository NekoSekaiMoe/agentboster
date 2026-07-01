# AGENTS.md

Compact guide for OpenCode sessions in this repo. Keep it short: only include facts that are easy to miss from filenames and scripts.

## Repo shape

- Root is the Web app (`Next.js 15.5` + `React 19` + `TypeScript 6`) and uses `yarn`. It is **not** a yarn workspace root.
- Three sibling subprojects under `subpackage/`, each self-contained with its own `AGENTS.md` — read that before editing inside one:
  - `subpackage/agentd/` — Go daemon (Linux-only, `//go:build linux`), own `go.mod` (Go 1.26.4). Runs the sandboxed execution plane.
  - `subpackage/cli/` — separate npm package, own `package.json`, Biome `2.3.5`, `@typescript/native-preview` (tsgo), `engines.node >=22.19.0`. Toolchain versions do **not** match root.
  - `subpackage/dbushelper/` — pure-Go AT-SPI2 D-Bus client (Go 1.26.4), own `go.mod`. Consumed by agentd's `tools_a11y.go` via the `a11y-helper` CLI.
- `@/*` maps to the repo root (`tsconfig.json` and `vitest.config.ts`); prefer it over long relative imports.
- Root `tsconfig.json` excludes `node_modules`, `ref`, `memoh`, `cli`, and `subpackage`, so root `tsc --noEmit` does not typecheck any subproject; run checks inside each subdir.
- `ref/` is vendored reference material, ignored by root TypeScript/Biome; do not edit it as app code.

## Commands

- `yarn dev` starts Next dev. The Workflow devkit (`withWorkflow`) wraps the build, so workflow step code is always in play.
- `yarn build` runs `next build`; it does **not** enforce type or lint correctness (see `next.config.ts`).
- `yarn lint:check` is the real gate before shipping. Exact form: `tsc --noEmit && biome check app components lib hooks middleware.ts next.config.ts drizzle.config.ts push.py` — note the scoped path list, not `biome check .`.
- `yarn test` runs `vitest run` (one-shot). Single file: `yarn test <path>`; watch: `yarn test:watch <path>`.
- Vitest `include` is fixed to `lib/**/*.test.ts`, `app/**/*.test.ts`, `hooks/**/*.test.ts`, `components/**/*.test.{ts,tsx}`, and `subpackage/cli/src/**/*.test.ts`. Root Vitest configures the `@/*` alias, so run `subpackage/cli/` tests from root (not from inside `subpackage/cli/`).
- `yarn publish` runs `yarn run check` first, which is **not** a defined script — treat it as broken; run `yarn lint:check` manually before shipping.
- `yarn build:agentd` builds agentd from repo root (the script does `cd agentd && go build ...`; works because yarn resolves the path, even though there is no top-level `agentd/`).
- DB commands need `DATABASE_URL`: `yarn db:generate`, `yarn db:push`, `yarn db:studio`, `yarn db:ensure-vector`.
- `yarn check:sh` runs `shellcheck` on the agentd node-install script.
- `yarn workflow:inspect` opens Workflow runs in a web UI.

### Inside `subpackage/`

- agentd / dbushelper (Go): `go build ./...`, `go vet ./...`, `go test ./...`. See each subdir's `AGENTS.md` for release-binary flags and test tags.
- cli: run `biome check`, `tsgo` (or the subdir's `tsc`), and tests from inside `subpackage/cli/` — root tooling versions do not apply.

## Web gotchas

- `next.config.ts` ignores ESLint and TypeScript build errors, so a green `yarn build` is not a quality signal.
- `postbuild` (`scripts/vercel-postbuild.ts`) only runs migrations when `VERCEL=1` **and** `VERCEL_ENV=production` (or `VERCEL_TARGET_ENV=production`); local builds never touch the DB.
- `middleware.ts` protects all routes unless explicitly bypassed; new `app/api/**` routes are session-gated by default.
- Daemon callbacks under `/api/agentd/v1/*` and `/api/soul/*` use mTLS + `AGENTD_API_KEY`, not the user session.
- Workflow step code runs in a sandbox without `fetch`, `__dirname`, `Buffer`, or direct DB access; any host-only helper reached from a workflow body must be marked `'use step'`.
- Do not import `next/server` or `next/headers` from the workflow tree; that has broken before on `__dirname` access.
- Use `createLogger` from `lib/utils/logger.ts` for server logging; avoid `console.log` in server code.

## Style and infra

- Biome (`biome.jsonc`, root `2.4.16`) is the only formatter/linter; do not run import sorters — `organizeImports` is off.
- The repo intentionally tolerates some Biome rules as warnings/off; do not "fix" disabled a11y or style rules unless the code itself needs it.
- `next.config.ts` keeps these as `serverExternalPackages` to avoid bundle breakage: `@chat-adapter/discord`, `@discordjs/ws`, `@vercel/queue`, `discord-interactions`, `discord.js`, `zlib-sync`.
- Custom SVG icons exist for lucide coverage gaps; use `lucide-react` for new icons unless the repo already has a bespoke asset.

## Cross-cutting conventions

- **agentd version bump**: when the on-disk cache format or HTTP contract changes, bump the `version` constant in `subpackage/agentd/cmd/agentd/main.go`. All HTTP responses use the `{ success, data, error }` envelope.
- **dbushelper wire contract**: `a11y-helper` emits one JSON object on stdout (parsed verbatim by agentd); diagnostics go to stderr only. Exit codes: `0` = success or per-action failure (JSON `ok=false`, includes `fallback` coords), `1` = catastrophic (bus unreachable), `2` = usage.
- **dbushelper refs**: snapshot writes `/tmp/agentd-a11y-refs.json` (overridable via `AGENTD_A11Y_REFS`); click/type/fill read it. Refs are tiered: `eN` = interactive (legal click/type/fill target), `xN` = group (inspect-only). Tests isolate via `t.Setenv("AGENTD_A11Y_REFS", ...)`.
- **dbushelper test tags**: `conn_unix_test.go` is `//go:build linux`; CLI e2e builds the binary as a subprocess and skips if `go` is not on PATH.

## Useful pointers

- `README.md` is the best high-level map; each subpackage has its own `README.md` and `AGENTS.md` — those are the authoritative boundaries.
- `subpackage/agentd/LAYOUT.MD` is the per-file code map for the daemon.
- `.agents/skills/` contains repo-local OpenCode skills (next-best-practices, vercel-react-best-practices, workflow, chat-sdk, ai-sdk, ui-ux-pro-max, bug-hunter); load the matching skill instead of re-deriving its rules.
