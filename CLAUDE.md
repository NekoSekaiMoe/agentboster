# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AgentBoster** — a serverless AI agent platform in two parts:

- `/` (root) — Next.js 15 web dashboard (App Router, RSC, React 19). Deploys to Vercel. Package name is `clawless` (internal codename).
- `/agentd/` — Go 1.26 daemon for sandboxed agent execution on a Linux server. Module `github.com/clawless/agentd`.

The web app handles the UI, IM bot adapters, and persistence. The daemon runs agent loops and sandboxes; it has no DB of its own and calls back to the web via mTLS + API key.

## Commands

```bash
# Web (Next.js) — use Yarn (not npm/pnpm/bun), CI uses yarn
yarn install
yarn dev                # http://localhost:3000
yarn check              # tsc --noEmit + biome check . --write  (run before committing)
yarn build
yarn postbuild          # Vercel postbuild: ensures pgvector + Drizzle schema push
yarn db:generate        # Drizzle: generate migrations from schema
yarn db:push            # Drizzle: push schema to DB
yarn db:studio
yarn format             # biome format --write
yarn lint:fix           # biome lint --write --unsafe
yarn push               # git add + commit + push (via push.py)

# Agent Daemon (Go)
cd agentd
go build -o agentd ./cmd/agentd/
./agentd -config agentd.toml
```

## High-level architecture

### Web (`/`)

```
app/(auth)/            — Login + /api/auth/login
app/(chat)/            — Chat UI, sessions, files, schedules
app/(config)/          — Provider/Channel/Agent config
app/(skill)/           — Skill management
app/(memory)/          — Memory/RAG management
app/.well-known/workflow/ — Vercel Workflow DevKit callbacks (bypasses auth middleware)

lib/auth/              — Auth config, session/cookie (bcryptjs)
lib/ai/                — AI SDK provider factory (Anthropic, Google, OpenAI, OpenAI-compatible)
lib/bot/               — Multi-channel bot adapters + webhook routing
lib/chat/              — Chat transport, streaming, session bootstrap, token usage
lib/core/db/           — Drizzle ORM schema (lib/core/db/schema/) + Neon Postgres client
lib/core/kv/           — Upstash Redis (config, skills, import jobs, locks)
lib/core/blob/         — Vercel Blob (file/skill storage)
lib/core/sandbox/      — Vercel Sandbox management
lib/memory/            — Memory: builtin, long-term (RAG chunks), session
lib/workflow/          — Vercel Workflow DevKit (agent/scheduled)
lib/extra/             — Server-only internals (channels, config, cron, security, sandbox)
types/                 — Shared TypeScript types
hooks/                 — React hooks for config UI (draft, validation, debounce)
components/ui/         — shadcn/ui primitives
```

### Daemon (`/agentd/`)

Entry: `cmd/agentd/main.go`. Config: `agentd.toml` (see `agentd.toml.example`).
HTTP via Gin, config via Viper (TOML), custom event bus + worker pool.

Key packages under `internal/`: `agent`, `sandbox` (tmpfs/chroot/docker providers), `security` (L0 rules / L1 LLM scoring / L2 user auth), `session`, `worker`, `eventbus`, `clawless` (web client), `persistence`, `certs`.

## Conventions

- **Path alias**: `@/*` maps to repo root (set in `tsconfig.json`).
- **Styling**: Tailwind CSS 3 + `tailwindcss-animate`. Dark mode via `next-themes` (`class` strategy). Colors use CSS custom properties (HSL vars).
- **Linting/formatting**: **Biome** (not ESLint/Prettier). Config: `biome.jsonc`. Run `yarn check` before committing.
- **DB**: Neon Postgres via Drizzle ORM. Schema lives in `lib/core/db/schema/`; barrel export at `lib/core/db/schema/index.ts`. Migrations output to `lib/core/db/migrations/`. Drizzle config: `drizzle.config.ts`.
- **Auth**: Cookie-based. `middleware.ts` protects all routes except `/login`, `/api/auth/login`, `/.well-known/workflow/*`, and public assets (file extensions).
- **Bot webhooks**: Auth secret is embedded in the callback URL path: `/api/bot/{AUTH_SECRET}/{adapter}/callback`.

## Key env vars

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `REDIS_URL` | Upstash Redis |
| `AUTH_SECRET` | Auth token signing secret |
| `USERNAME` / `PASSWORD` | Login credentials |
| `NEXT_PUBLIC_VERCEL_ENV` | Vercel environment |
| `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL` | Production hostname for webhook URLs |
| `VERCEL` / `VERCEL_ENV` / `VERCEL_TARGET_ENV` | Used by postbuild script |

## Gotchas

- `.env.local` is gitignored. You need `DATABASE_URL` and `REDIS_URL` for local dev. Run `yarn vercel pull` to fetch env vars from Vercel.
- If you hit database schema errors locally, run `yarn postbuild` (or `yarn db:push`) to apply migrations.
- `postbuild` only runs Drizzle push on Vercel production builds (checks `VERCEL` + `VERCEL_ENV`/`VERCEL_TARGET_ENV`).
- `middleware.ts` matcher excludes `_next/static`, `_next/image`, `favicon.ico`, and `.well-known/workflow/` — workflow callbacks intentionally bypass auth.
- Biome: `useImportType` is `"off"` — do not auto-fix imports to `import type`. `noExplicitAny` is `"warn"`, not error.
- CI runs **Yarn** (not Bun/npm): `yarn check` in `.github/workflows/lint.yml`.
- `ref/` is a separate reference project with its own `package.json` and `pnpm-lock.yaml` — Biome ignores it, tsconfig excludes it, leave it alone.
- The daemon uses **Go 1.26** (not 1.22/1.23); check `agentd/go.mod` before upgrading syntax.

## CI

- `.github/workflows/lint.yml` — runs `yarn check` on push/PR.
- `.github/workflows/docs-pages.yml` — deploys `.docs/` to GitHub Pages on pushes to `main`.

## Required env vars for deployment

`AUTH_SECRET`, `USERNAME`, `PASSWORD` — do not leak.
