# AGENTS.md

Compact guide for OpenCode sessions in this repo. Keep it short: only include facts that are easy to miss from filenames and scripts.

## Before coding

- **Do not run yarn build in development**: It can only waste time and cpu.
- **Path alias**: `@/*` maps to repo root (`tsconfig.json`).
- **shadcn/ui**: Components in `components/`, UI primitives in `components/ui/`. Aliases: `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.
- **Styling**: Tailwind CSS 3 + `tailwindcss-animate`. Dark mode via `next-themes` (`class` strategy). Colors use CSS custom properties (HSL vars).
- **Linting**: Biome (not ESLint/Prettier). Config: `biome.jsonc`. Run `yarn run check` before committing. However, `yarn run check` does NOT auto-fix code (`--write` flag removed). It only reports issues because it cause many unsafe changes. Use `yarn format` or `yarn lint:fix` for auto-fixing, but review the changes carefully before committing. Many Biome auto-fixes can be incorrect (e.g., changing `let` to `const` when the variable is mutated later).
- **Logging**: Use `createLogger` from `lib/utils/logger.ts` for server-side logging (Vercel logs). Never use `console.log` in server code — it won't appear in Vercel logs properly. For client-side debugging, `console.log` is fine.
- **DB**: Neon Postgres via Drizzle ORM. Schema in `lib/core/db/schema/`. Migrations output to `lib/core/db/migrations/`.
- **Auth**: Cookie-based. Requires `AUTH_SECRET`, `USERNAME`, `PASSWORD` env vars. Middleware in `middleware.ts` protects all routes except `/login`, `/api/auth/login`, `/.well-known/workflow/*`, and public assets (`.*` file extensions).
- **Bot webhooks**: Auth secret is embedded in the callback URL path (`/api/bot/{AUTH_SECRET}/{adapter}/callback`). CI uses Yarn (`yarn run check`).

### Workflow / skills / opencode

- `.agents/skills/` contains repo-local OpenCode skills (ai-sdk, bug-hunter, chat-sdk, workflow, etc.). The skills are intended for OpenCode sessions in this repo — load them when a task matches, don't reimplement what they encode.

### Things that look like bugs but aren't

- `push.py` runs `git add . && git commit && git push` (the `yarn push` script). It also strips `ref/` from the index. Don't replace it with a normal `git push` — the `ref/` strip is intentional.
- `next.config.ts` `serverExternalPackages` includes `playwright`, `zlib-sync`, and the chat adapters — they break under bundling. Don't move them into the bundle.
- Many `@radix-ui/*` packages are listed in `optimizePackageImports`. Adding new Radix packages should follow the same pattern or bundle size regresses.
- The custom SVG icons in `components/icons.tsx` exist only because `lucide-react` didn't have equivalents at the time; prefer `lucide-react` for all new icon needs (e.g. `Maximize`/`Minimize` for fullscreen, not a hand-rolled SVG).
- **Workflow DevKit sandbox can't import `next/server`**: the DevKit runs the bundled workflow code in a `vm.Script.runInContext` sandbox whose context (created by `vm.createContext()`) does not define `__dirname`. Several ncc-compiled bundles under `node_modules/next/dist/compiled/...` (notably `ua-parser-js`, pulled in by `next/server`) read `__dirname` at init and crash with `ReferenceError: __dirname is not defined`. Do NOT import `next/server`, `next/headers`, or any other Next.js server primitive from inside `lib/workflow/agent/index.ts` (or anything it imports). For "run this after the response closes" semantics, use `afterResponse()` from `lib/workflow/agent/after-response.ts` — the host drains the queue when the workflow's readable stream closes (see `lib/workflow/agent/dispatch.ts`). Setting `globalThis.__dirname` from the host does NOT work (the sandbox context is isolated).
- **Top-level `node:*` imports break the workflow bundle even in non-step exports.** The workflow DevKit bundler (`@workflow/core`) walks imports **statically per file**: as soon as any file under `lib/workflow/**` is reachable from a workflow body, every top-level `import ... from 'node:fs'` / `'node:path'` / `'node:crypto'` / etc. in that file becomes part of the steps bundle, and the `workflow-node-module-error` esbuild plugin fails the **whole `yarn build`** with `ERROR: You are attempting to use "node:fs" which is a Node.js module. Node.js modules are not available in workflow functions.` This is **not** caught by `yarn lint:check` or `yarn test` — only `yarn build` runs the workflow bundler, and `next.config.ts` is configured to ignore build errors, so the failure surfaces as a hard stop only at build time. The trap is that a function doesn't have to be `'use step'` to trigger this — promoting a `readFileSync` call from inside a `'use step'` function into a non-step sibling export (while keeping the top-level `import { readFileSync } from 'node:fs'`) silently breaks the build. **Rule: in any file that is (or might transitively become) part of the workflow bundle, never use top-level `node:*` imports — use `const { x } = await import('node:fs')` inside the function body.** The dynamic import is invisible to the static bundle analyzer and resolves at runtime, where these functions always run on the host (step body or route handler, both Node). See commit 3803c20 for the regression that established this rule.
  - **`import type { X } from 'node:*'` is also a violation — do not use it.** The esbuild plugin does NOT distinguish `import` from `import type`; any top-level reference to a `node:*` specifier is flagged. The reported error location is misleading: it points at the first *use* of the imported identifier (e.g. `type Foo = HttpRequestOptions & ...`), not at the import line, so the failure looks like a type-expression violation rather than an import violation. If you need a Node type (e.g. `http.RequestOptions`), inline a local structural interface that mirrors only the fields you actually populate — do not import the type. See commit 4d949bc for the regression where `import type` slipped past review.

### Operational lessons (process discipline)

These are concrete traps hit during the P0–P3 work. Re-read before touching workflow bundles or merging duplicate routes.

- **Never guess whether a sandbox/worker boundary shares globals with the host — read the context-creation source first.** A previous fix attempt set `globalThis.__dirname` from the host process to paper over the workflow sandbox crash above. It failed silently because `vm.createContext()` (in `node_modules/@workflow/core/dist/vm/index.js`) builds a brand-new isolated global object — assignments to the host's `globalThis` are invisible inside the sandbox. The right move was to remove the offending import (`next/server`) from the bundle entirely. Generalize: any time a fix targets a vm/worker/iframe/child_process boundary, **first read the actual context-creation code**, don't assume globals leak through.
- **When merging duplicate routes (e.g., `(group)/api/...` vs `api/...`), diff the implementations line by line — don't pick a winner by line count or "looks more complete."** During P0.4 the `(chat)/api/agentd` tree was merged into `api/agentd`. The merge picked the root-side `notifications/send` because it was longer, but the longer version used the low-level `sendAdapterSourceReply` while the discarded `(chat)` version used `sendNotification` (which respects user preferences and falls back across IM channels). The merge also silently dropped the GET/PUT methods on `/notifications` (channel health + preference management) because only the POST had a counterpart on the root side. Line counts lied. Generalize: for any duplicate-route merge, itemize every HTTP method, every external helper (`sendNotification` vs `sendAdapterSourceReply`, `extractTaskMemory` vs `extractMemoriesFromSession`, `requireTaskAccess`, etc.), and every DB write — then choose deliberately, not by length

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
- `yarn build` runs `next build`; it does **not** enforce type or lint correctness (see `next.config.ts`). However, it **does** run the workflow DevKit bundler, which is the only place that catches workflow-bundle violations (top-level `node:*` imports, etc. — see the bullet above). So: lint:check is the gate for types/format, build is the gate for workflow-bundle compatibility. After touching anything under `lib/workflow/**` (or files transitively reachable from a workflow body, like `lib/extra/agent/agentd-tools-client.ts`), run `yarn build` before committing — `yarn lint:check` + `yarn test` passing is NOT enough.
- `yarn lint:check` is the real gate before shipping. Exact form: `tsc --noEmit && biome check app components lib hooks middleware.ts next.config.ts drizzle.config.ts push.py` — note the scoped path list, not `biome check .`.
- `yarn test` runs `vitest run` (one-shot). Single file: `yarn test <path>`; watch: `yarn test:watch <path>`.
- Vitest `include` is fixed to `lib/**/*.test.ts`, `app/**/*.test.ts`, `hooks/**/*.test.ts`, `components/**/*.test.{ts,tsx}`, and `subpackage/cli/src/**/*.test.ts`. Root Vitest configures the `@/*` alias, so run `subpackage/cli/` tests from root (not from inside `subpackage/cli/`).
- `yarn publish` runs `yarn run lint:check` first (i.e. `tsc --noEmit && biome check ...`), then `yarn build` and `git push`.
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
- `/api/agentd/v1/health` vs `/api/agentd/v1/available` are NOT interchangeable. `health` reports the single daemon reachable via `AGENTD_URL`/`nodes[0]` (consumed by the agentd-config "Web Direct Connection" card and by agentd's own reverse connectivity check via `clawless/client.go` `HealthCheck`, which only inspects the HTTP status code). `available` is multi-node-aware — it returns whether `isAgentdAvailable()` (DB online check + per-selected-node health probe) would let `execToolOnAgentd` dispatch. Chat-header's agentd pill uses `available`; do not switch it back to `health` or multi-node installs will show offline when `nodes[0]` is down but another node can serve.
- Workflow step code runs in a sandbox without `fetch`, `__dirname`, `Buffer`, or direct DB access; any host-only helper reached from a workflow body must be marked `'use step'`.
- Do not import `next/server` or `next/headers` from the workflow tree; that has broken before on `__dirname` access.
- Do not use top-level `node:*` imports (`node:fs`/`node:path`/`node:crypto`/...) anywhere in the workflow tree (`lib/workflow/**`, or anything transitively reachable from a workflow body) — the workflow bundler fails the whole `yarn build` with a hard error that lint/test don't catch. `import type` from `node:*` is equally forbidden. See the dedicated bullet above for the full rule and the `await import()` workaround.
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
