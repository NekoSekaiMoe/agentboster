# AGENTS.md

Compact guide for OpenCode sessions working in this repo. The codebase has two independent components that talk over mTLS — read the section relevant to your task.

## Important: After coding before committing

- **Path alias**: `@/*` maps to repo root (`tsconfig.json`).
- **shadcn/ui**: Components in `components/`, UI primitives in `components/ui/`. Aliases: `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.
- **Styling**: Tailwind CSS 3 + `tailwindcss-animate`. Dark mode via `next-themes` (`class` strategy). Colors use CSS custom properties (HSL vars).
- **Linting**: Biome (not ESLint/Prettier). Config: `biome.jsonc`. Run `yarn run check` before committing. However, `yarn run check` does NOT auto-fix code (`--write` flag removed). It only reports issues because it cause many unsafe changes. Use `yarn format` or `yarn lint:fix` for auto-fixing, but review the changes carefully before committing. Many Biome auto-fixes can be incorrect (e.g., changing `let` to `const` when the variable is mutated later).
- **Logging**: Use `createLogger` from `lib/utils/logger.ts` for server-side logging (Vercel logs). Never use `console.log` in server code — it won't appear in Vercel logs properly. For client-side debugging, `console.log` is fine.
- **DB**: Neon Postgres via Drizzle ORM. Schema in `lib/core/db/schema/`. Migrations output to `lib/core/db/migrations/`.
- **Auth**: Cookie-based. Requires `AUTH_SECRET`, `USERNAME`, `PASSWORD` env vars. Middleware in `middleware.ts` protects all routes except `/login`, `/api/auth/login`, `/.well-known/workflow/*`, and public assets (`.*` file extensions).
- **Bot webhooks**: Auth secret is embedded in the callback URL path (`/api/bot/{AUTH_SECRET}/{adapter}/callback`). CI uses Yarn (`yarn run check`).

## Repository layout

Two components, no shared code or build system:

- **Web app (this repo root)** — Next.js 15.5 App Router on Vercel. TypeScript 6, React 19, Biome, Drizzle ORM, Vercel Workflow DevKit. Yarn is the package manager (lockfile is `yarn.lock`, not `package-lock.json`).
- **`agentd/`** — separate Go 1.26 module (`agentd/go.mod`). Linux-only daemon, runs on user servers, talks to the Web over mTLS. Build/test with `go`, not the root toolchain. See `agentd/README.md` and `agentd/LAYOUT.MD`.

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
yarn publish             # check + build + git push (the canonical "ship it" path)
yarn deploy              # vercel --prod
```

Run a single test file: `yarn test <path>` or `yarn test:watch <path>`. Vitest picks up `lib/**/*.test.ts`, `app/**/*.test.ts`, `hooks/**/*.test.ts`, and `components/**/*.test.{ts,tsx}` (see `vitest.config.ts`). Anything outside those globs is silently ignored.

### Build gotchas

- `next.config.ts` sets `eslint.ignoreDuringBuilds` and `typescript.ignoreBuildErrors: true`. **`next build` will not catch type or lint errors.** Always run `yarn check` separately — it is the only thing enforcing types.
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
- `MULTI-NODE-SCHEDULING.md`, `security-level.md`, `gatekeeper-diff.md`, `SECURITY.md` carry operational/security context for the Web↔Daemon gatekeeper and L0/L1/L2 model. Read them before touching `lib/security/`, `lib/workflow/`, or any L2-decision code.

## Things that look like bugs but aren't

- `push.py` runs `git add . && git commit && git push` (the `yarn push` script). It also strips `ref/` from the index. Don't replace it with a normal `git push` — the `ref/` strip is intentional.
- `next.config.ts` `serverExternalPackages` includes `playwright`, `zlib-sync`, and the chat adapters — they break under bundling. Don't move them into the bundle.
- Many `@radix-ui/*` packages are listed in `optimizePackageImports`. Adding new Radix packages should follow the same pattern or bundle size regresses.
- The custom SVG icons in `components/icons.tsx` exist only because `lucide-react` didn't have equivalents at the time; prefer `lucide-react` for all new icon needs (e.g. `Maximize`/`Minimize` for fullscreen, not a hand-rolled SVG).
- **Workflow DevKit sandbox can't import `next/server`**: the DevKit runs the bundled workflow code in a `vm.Script.runInContext` sandbox whose context (created by `vm.createContext()`) does not define `__dirname`. Several ncc-compiled bundles under `node_modules/next/dist/compiled/...` (notably `ua-parser-js`, pulled in by `next/server`) read `__dirname` at init and crash with `ReferenceError: __dirname is not defined`. Do NOT import `next/server`, `next/headers`, or any other Next.js server primitive from inside `lib/workflow/agent/index.ts` (or anything it imports). For "run this after the response closes" semantics, use `afterResponse()` from `lib/workflow/agent/after-response.ts` — the host drains the queue when the workflow's readable stream closes (see `lib/workflow/agent/dispatch.ts`). Setting `globalThis.__dirname` from the host does NOT work (the sandbox context is isolated).

## Operational lessons (process discipline)

These are concrete traps hit during the P0–P3 work. Re-read before touching workflow bundles or merging duplicate routes.

- **Never guess whether a sandbox/worker boundary shares globals with the host — read the context-creation source first.** A previous fix attempt set `globalThis.__dirname` from the host process to paper over the workflow sandbox crash above. It failed silently because `vm.createContext()` (in `node_modules/@workflow/core/dist/vm/index.js`) builds a brand-new isolated global object — assignments to the host's `globalThis` are invisible inside the sandbox. The right move was to remove the offending import (`next/server`) from the bundle entirely. Generalize: any time a fix targets a vm/worker/iframe/child_process boundary, **first read the actual context-creation code**, don't assume globals leak through.
- **When merging duplicate routes (e.g., `(group)/api/...` vs `api/...`), diff the implementations line by line — don't pick a winner by line count or "looks more complete."** During P0.4 the `(chat)/api/agentd` tree was merged into `api/agentd`. The merge picked the root-side `notifications/send` because it was longer, but the longer version used the low-level `sendAdapterSourceReply` while the discarded `(chat)` version used `sendNotification` (which respects user preferences and falls back across IM channels). The merge also silently dropped the GET/PUT methods on `/notifications` (channel health + preference management) because only the POST had a counterpart on the root side. Line counts lied. Generalize: for any duplicate-route merge, itemize every HTTP method, every external helper (`sendNotification` vs `sendAdapterSourceReply`, `extractTaskMemory` vs `extractMemoriesFromSession`, `requireTaskAccess`, etc.), and every DB write — then choose deliberately, not by length.
