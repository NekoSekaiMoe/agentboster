# AGENTS.md

Compact guide for OpenCode sessions working in this repo. The codebase has three deployable parts — **Web** (repo root), **`agentd/`** (Go daemon), and **`cli/`** (terminal client) — that talk over HTTPS (and optional mTLS for Web→daemon). Read the section relevant to your task.

## Important: After coding before committing

- **Path alias**: `@/*` maps to repo root (`tsconfig.json`).
- **shadcn/ui**: Components in `components/`, UI primitives in `components/ui/`. Aliases: `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.
- **Styling**: Tailwind CSS 3 + `tailwindcss-animate`. Dark mode via `next-themes` (`class` strategy). Colors use CSS custom properties (HSL vars).
- **Linting**: Biome (not ESLint/Prettier). Config: `biome.jsonc`. Run `yarn lint:check` before committing — it runs `tsc --noEmit && biome check .` (read-only, no auto-fix). Use `yarn format` or `yarn lint:fix` for auto-fixing, but review changes carefully: Biome auto-fixes can be incorrect (e.g., changing `let` to `const` when the variable is mutated later).
- **Logging**: Use `createLogger` from `lib/utils/logger.ts` for server-side logging (Vercel logs). Never use `console.log` in server code — it won't appear in Vercel logs properly. For client-side debugging, `console.log` is fine.
- **DB**: Neon Postgres via Drizzle ORM. Schema in `lib/core/db/schema/`. Migrations output to `lib/core/db/migrations/`.
- **Auth**: Cookie-based. Requires `AUTH_SECRET`, `USERNAME`, `PASSWORD` env vars. Middleware in `middleware.ts` protects all routes except: login paths, bot webhook paths (`/api/bot/{AUTH_SECRET}/...`), daemon callbacks (`/api/agentd/v1/*`, `/api/soul/*` — require `AGENTD_API_KEY`), server-to-server IM stream (`/api/internal/im-stream`), workflow webhooks (`/.well-known/workflow/*`), and public assets (any path ending in a file extension).
- **Bot webhooks**: Auth secret is embedded in the callback URL path (`/api/bot/{AUTH_SECRET}/{adapter}/callback`).

## Repository layout

Three parts, separate build toolchains (Web/cli use npm/yarn ecosystems; agentd uses Go):

- **Web app (repo root)** — Next.js 15.5 App Router on Vercel. TypeScript 6, React 19, Biome, Drizzle ORM, Vercel Workflow DevKit. Yarn (`yarn.lock`).
- **`agentd/`** — Go 1.26 module (`agentd/go.mod`). Linux-only daemon; Daemon→Web uses HTTPS + API key; Web→daemon may use mTLS. See `agentd/AGENTS.md`, `agentd/README.md`.
- **`cli/`** — npm workspaces; `agentboster` CLI and `@agentboster/adapter`. See `cli/README.md`, `cli/AGENTS.md`.

Other things an agent would misread:
- `CLAUDE.md` is a symlink to this file — keep this file as the source of truth.
- Path alias is `@/*` → repo root (configured in `tsconfig.json` and mirrored in `vitest.config.ts`). Don't add relative imports when `@/` works.
- `agentd/` is excluded from the Biome/TS workspace; do not run root `check` or `format` against it.
- `ref/` is vendored reference material — biome and tsc both ignore it, and `push.py` explicitly `git rm --cached`s it. Do not edit it as project code.

## Web app commands

```bash
yarn dev                 # next dev (Turbopack)
yarn build               # next build (also runs postbuild, which is a no-op outside Vercel prod)
yarn start               # serve built app
yarn lint:check          # tsc --noEmit && biome check .   <- run this before pushing
yarn lint:fix            # biome lint . --write --unsafe
yarn format              # biome format . --write
yarn test                # vitest run
yarn test:watch
yarn publish             # lint:check + build + git push (canonical "ship it" path)
                         # NOTE: `publish` references `yarn run check` in package.json
                         # but the script is named `lint:check`. Run `yarn lint:check` manually.
yarn deploy              # vercel --prod
```

Run a single test file: `yarn test <path>` or `yarn test:watch <path>`. Vitest picks up `lib/**/*.test.ts`, `app/**/*.test.ts`, `hooks/**/*.test.ts`, and `components/**/*.test.{ts,tsx}` (see `vitest.config.ts`). Anything outside those globs is silently ignored.

### Build gotchas

- `next.config.ts` sets `eslint.ignoreDuringBuilds` and `typescript.ignoreBuildErrors: true`. **`next build` will not catch type or lint errors.** Always run `yarn lint:check` separately — it is the only thing enforcing types.
- The build wraps the config in `withWorkflow` from `workflow/next`; the Workflow DevKit is a hard dependency, not optional.
- `postbuild` (`scripts/vercel-postbuild.ts`) only runs DB operations when `VERCEL=1` and `VERCEL_ENV=production`. Locally it exits early — do not expect local builds to touch the DB.

## Database (Drizzle + Neon Postgres + pgvector)

- Schema source of truth: `lib/core/db/schema/index.ts`. Migrations live in `lib/core/db/migrations/` (SQL files, hand-edited — see `0003_*`).
- `DATABASE_URL` is required for any DB command. The checked-in `.env` only sets `NEXT_TELEMETRY_DISABLED`; real credentials are managed in Vercel, not committed.
- Commands:
  ```bash
  yarn db:generate        # generate a new SQL migration from schema diff
  yarn db:push            # apply schema to the DB (also runs in Vercel postbuild)
  yarn db:studio          # drizzle-kit studio
  yarn db:ensure-vector   # CREATE EXTENSION IF NOT EXISTS vector;  (runs before db:push on Vercel)
  ```
- pgvector is a hard requirement (memory/RAG uses it). `db:push` will fail on a fresh DB if the vector extension hasn't been enabled — `db:ensure-vector` exists for this reason.

## Code style (Biome, not ESLint/Prettier)

- Biome is the only formatter/linter. Config: `biome.jsonc`. No ESLint, no Prettier.
- Single quotes, 2-space indent, semicolons, trailing commas, double quotes for JSX. Don't fight the formatter.
- `organizeImports` is **off** — do not run import sorters; existing import order is intentional.
- Several a11y rules are intentionally disabled (see comments in `biome.jsonc`). Don't "fix" them.
- `useImportType` is off, `useJsxKeyInIterable` is off, `noExplicitAny` is warn (not error). Match the existing tolerance level.

## Auth and middleware

- `middleware.ts` runs on every request and verifies an auth cookie (`AUTH_COOKIE_NAME`) via `lib/auth/session`. Any new API route under `app/api/**` is gated unless you add it to the bypass list (see `isAgentdBypassPath` for the daemon callback paths, and the Workflow `/.well-known/workflow/` bypass).
- Daemon → Web callbacks live under `/api/agentd/v1/*` and are authenticated by mTLS + API key, **not** the user session. Don't reuse user-auth helpers for those routes.

## agentd (Go daemon) commands

```bash
cd agentd
go build -o agentd ./cmd/agentd/         # or: yarn build:agentd from the repo root
go test ./...                            # verify daemon changes
go vet ./... && go build ./...           # broader static + build checks
sudo go run ./cmd/agentd/ -config agentd.toml   # local run (must be root, Linux only)
```

Non-obvious constraints:
- Linux-only — build tags (`//go:build linux`) enforce this. Cross-compiling to macOS/Windows is not supported.
- Must run as root at startup (drops privileges to `run_as_user` after setup). Non-root launches are refused.
- Config is TOML (`agentd.toml.example` is the template). Env override prefix is `AGENTD_`, e.g. `AGENTD_SERVER_LISTEN=:28732`.
- Version is a constant in `cmd/agentd/main.go`; bump it when the HTTP contract or on-disk cache format changes.

## Workflow / skills / opencode

- `.agents/skills/` contains repo-local OpenCode skills (ai-sdk, bug-hunter, chat-sdk, workflow, etc.). The skills are intended for OpenCode sessions in this repo — load them when a task matches, don't reimplement what they encode.
- `MULTI-NODE-SCHEDULING.md` and `BUILD_OPTIMIZATION.md` carry operational context. Read `MULTI-NODE-SCHEDULING.md` before touching multi-node dispatch code.

## Things that look like bugs but aren't

- `push.py` runs `git add . && git commit && git push` (the `yarn push` script). It also strips `ref/` from the index. Don't replace it with a normal `git push` — the `ref/` strip is intentional.
- `next.config.ts` `serverExternalPackages` includes `playwright`, `zlib-sync`, and the chat adapters — they break under bundling. Don't move them into the bundle.
- Many `@radix-ui/*` packages are listed in `optimizePackageImports`. Adding new Radix packages should follow the same pattern or bundle size regresses.
- The custom SVG icons in `components/icons.tsx` exist only because `lucide-react` didn't have equivalents at the time; prefer `lucide-react` for all new icon needs (e.g. `Maximize`/`Minimize` for fullscreen, not a hand-rolled SVG).
- **Workflow DevKit sandbox is `fetch`-less and `__dirname`-less** — code inside `'use workflow'` function bodies runs in `vm.Script.runInContext` against a context built by `node_modules/@workflow/core/dist/vm/index.js` `createContext()`. That context deliberately injects only **"stateless + synchronous Web APIs"** (the file's own comment): `Headers`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `structuredClone`, `atob`, `btoa`, `console`, plus `process.env` as a frozen snapshot. **There is no `fetch`, no `Request`/`Response`, no `Buffer`, no `__dirname`, no `fs`, no `pg`, no real `process`.** Any code path reached from the workflow function body (factory callbacks, top-level awaits inside the workflow function) that ultimately calls a host-only API will throw. Two concrete failures already hit:
  - **`next/server` import** — ncc-compiled `ua-parser-js` inside `next/server` reads `__dirname` at init → `ReferenceError: __dirname is not defined`. Do NOT import `next/server`/`next/headers` from anything inside `lib/workflow/agent/index.ts`. For "run this after the response closes" use `afterResponse()` from `lib/workflow/agent/after-response.ts` — the host drains the queue when the workflow's readable stream closes.
  - **`db` from `@/lib/core/db`** — it's a lazy Proxy that on first access instantiates `@neondatabase/serverless`, whose query path ends in a bare `fetch(...)` call (`(fetchFunction ?? fetch)(...)`). In the sandbox `typeof fetch === "undefined"`, so the query throws `ReferenceError: fetch is not defined`. Drizzle wraps that as `Error: Failed query: <sql>` with **no underlying Postgres message** (no `column does not exist`, no `relation ... does not exist`) — the missing-pg-message shape is the fingerprint of a sandbox boundary violation, NOT a schema problem.
  - **The escape hatch is `'use step'`** (and `'use hook'`). Functions marked with `'use step'` are serialized into an invocation queue and marshalled back to the host Node.js process to execute, where `fetch`/`__dirname`/etc. are all available. See `node_modules/@workflow/core/dist/step.js` `createUseStep`. **Every helper that calls `db`, `fetch`, `fs.promises`, or any other host-only API from inside the workflow tree MUST be declared `async function name(...) { 'use step'; ... }`.** Compare `lib/workflow/agent/tools/tasks/summary.ts` (correct — `readTaskSummaryStep` is `'use step'`) with the regression that triggered this rule (now fixed): `lib/workflow/agent/tools/agentd/nodes.ts` used to call `await db.select(...)` directly inside its factory, aborting every workflow with the `Failed query:` error above. The fix + the regression test live next to it (`nodes.test.ts` statically asserts every db helper contains `'use step'`).
  - **Tool `execute` callbacks are an exception**: they run on the host, not inside the vm context (the DevKit marshals tool execution via the events channel). So `execute: async (input) => { ... }` bodies may call `db`/`fetch` directly without a `'use step'` wrapper. Only **factory bodies** and other code reached during the synchronous workflow function execution need the step wrapper.
  - **Setting `globalThis.fetch` / `globalThis.__dirname` from the host does NOT work** — `vm.createContext()` builds a brand-new isolated global object; assignments to the host's `globalThis` are invisible inside the sandbox. Verify before assuming any global leaks across the boundary.

## Operational lessons (process discipline)

These are concrete traps hit during the P0–P3 work. Re-read before touching workflow bundles or merging duplicate routes.

- **Never guess whether a sandbox/worker boundary shares globals with the host — read the context-creation source first.** A previous fix attempt set `globalThis.__dirname` from the host process to paper over the workflow sandbox crash above. It failed silently because `vm.createContext()` (in `node_modules/@workflow/core/dist/vm/index.js`) builds a brand-new isolated global object — assignments to the host's `globalThis` are invisible inside the sandbox. The right move was to remove the offending import (`next/server`) from the bundle entirely. Generalize: any time a fix targets a vm/worker/iframe/child_process boundary, **first read the actual context-creation code**, don't assume globals leak through.
- **When merging duplicate routes (e.g., `(group)/api/...` vs `api/...`), diff the implementations line by line — don't pick a winner by line count or "looks more complete."** During P0.4 the `(chat)/api/agentd` tree was merged into `api/agentd`. The merge picked the root-side `notifications/send` because it was longer, but the longer version used the low-level `sendAdapterSourceReply` while the discarded `(chat)` version used `sendNotification` (which respects user preferences and falls back across IM channels). The merge also silently dropped the GET/PUT methods on `/notifications` (channel health + preference management) because only the POST had a counterpart on the root side. Line counts lied. Generalize: for any duplicate-route merge, itemize every HTTP method, every external helper (`sendNotification` vs `sendAdapterSourceReply`, `extractTaskMemory` vs `extractMemoriesFromSession`, `requireTaskAccess`, etc.), and every DB write — then choose deliberately, not by length.
