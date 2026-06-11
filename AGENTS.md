# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AgentBoster — Agent Instructions

## What This Is

A **serverless AI agent platform** in two parts:

- **`/` (root)** — Next.js 15 web dashboard (Vercel). App Router, RSC, React 19.
- **`/agentd/`** — Go 1.26 daemon for sandboxed agent execution on a Linux server.

The app is internally named "AgentBoster" (see `app/layout.tsx`, package name).

## Architecture Map

```
app/(auth)/          — Login page + /api/auth/login
app/(chat)/          — Chat UI, sessions, files, schedules
app/(config)/        — Provider/Channel/Agent config
app/(skill)/         — Skill management
app/(memory)/        — Memory/RAG management
app/.well-known/workflow/ — Vercel Workflow DevKit callbacks (bypasses auth middleware)

app/api/             — API routes:
  /api/auth/         — Login endpoint
  /api/agentd/v1/    — Daemon callbacks (L1 scoring, L2 decisions)
  /api/bot/[authSecret]/[adapter]/ — IM webhook endpoints (auth secret in URL path)
  /api/config/       — Config management, monitoring, audit logs
  /api/l2-authorizations/ — Security decision queue (pending, history, batch approve/reject)
  /api/tasks/        — Task history
  /api/notifications/ — Notification management
  /api/sandbox/      — Sandbox tools
  /api/pair/         — Daemon pairing

lib/auth/            — Auth config, session/cookie management (bcryptjs)
lib/ai/              — AI SDK provider factory (Anthropic, Google, OpenAI, OpenAI-compatible)
lib/bot/             — Multi-channel bot adapters + webhook routing
lib/chat/            — Chat transport, streaming, session bootstrap, token usage
lib/core/            — Infrastructure: db/ (Drizzle+Neon), kv/ (Upstash Redis), blob/ (Vercel Blob), sandbox/ (Vercel Sandbox)
lib/extra/           — Server-only business logic: agent/ (daemon client, parallel execution, skills), channels/, config/, cron/, memory/, prompts/, sandbox/, security/
lib/memory/          — Memory: builtin, long-term (RAG chunks), session
lib/security/        — Web-side security: L1 LLM scorer, L2 decision queue
lib/workflow/        — Vercel Workflow DevKit: agent/ (agent workflows), scheduled/ (cron workflows)
lib/utils/           — Shared utilities: logger, runtime health
types/               — Shared TypeScript types (config, memory, skills, workflow)
hooks/               — React hooks for config UI (draft, validation, debounce)
```

## Commands

```bash
# Web (Next.js)
yarn install          # Install deps (uses yarn.lock)
yarn dev              # Start dev server (http://localhost:3000)
yarn run check        # Typecheck + Biome lint/format (run before committing)
yarn build            # Production build
yarn postbuild        # Vercel postbuild: ensures pgvector + Drizzle schema push
yarn db:generate      # Drizzle generate migrations
yarn db:push          # Drizzle push schema
yarn db:studio        # Drizzle Studio
yarn format           # Biome format --write
yarn lint:fix         # Biome lint --write --unsafe
yarn deploy           # vercel --prod
yarn publish          # check + build + git push
yarn push             # git add . ; git commit ; git push (via push.py)

# Agent Daemon (Go)
cd agentd
go build -o agentd ./cmd/agentd/
./agentd -config agentd.toml
```

**Note**: This project does not have a test suite. There are no test commands or test files.

## Important Conventions

- **Path alias**: `@/*` maps to repo root (`tsconfig.json`).
- **shadcn/ui**: Components in `components/`, UI primitives in `components/ui/`. Aliases: `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.
- **Styling**: Tailwind CSS 3 + `tailwindcss-animate`. Dark mode via `next-themes` (`class` strategy). Colors use CSS custom properties (HSL vars).
- **Linting**: Biome (not ESLint/Prettier). Config: `biome.jsonc`. Run `yarn run check` before committing.
- **DB**: Neon Postgres via Drizzle ORM. Schema in `lib/core/db/schema/`. Migrations output to `lib/core/db/migrations/`.
- **Auth**: Cookie-based. Requires `AUTH_SECRET`, `USERNAME`, `PASSWORD` env vars. Middleware in `middleware.ts` protects all routes except `/login`, `/api/auth/login`, `/.well-known/workflow/*`, and public assets (`.*` file extensions).
- **Bot webhooks**: Auth secret is embedded in the callback URL path (`/api/bot/{AUTH_SECRET}/{adapter}/callback`). CI uses Yarn (`yarn run check`).

## Key Env Vars

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `REDIS_URL` | Upstash Redis connection string |
| `AUTH_SECRET` | Auth token signing secret |
| `USERNAME` / `PASSWORD` | Login credentials |
| `NEXT_PUBLIC_VERCEL_ENV` | Vercel environment (production/preview/development) |
| `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL` | Production hostname for webhook URLs |
| `VERCEL` / `VERCEL_ENV` / `VERCEL_TARGET_ENV` | Used by postbuild script |

## Agent Daemon (`/agentd/`)

- Go 1.26.2, module `github.com/clawless/agentd`.
- HTTP: Gin. Config: Viper (TOML). Event bus + worker pool pattern.
- Entry: `cmd/agentd/main.go`. Config: `agentd.toml` (example: `agentd.toml.example`).
- Communicates with web via mTLS + API key. No local DB — all persistence through the web API.
- Three sandbox types: tmpfs (lightweight), chroot (persistent), Docker (strong isolation).
- Three-tier security: L0 rules → L1 LLM scoring → L2 user authorization.

**Internal packages** (`internal/`):
- `agent/` — LLM loop, tool definitions (codeact, exec, file, git, web, memory, skills, subagent, media, deliver, task summary), tool registration, context management
- `worker/` — Task dispatcher, worker pool, writers
- `sandbox/` — Sandbox providers (docker, docker_light, lxc_persistent), workspace management, media handling, skills loading, availability checking
- `security/` — Security rules and enforcement
- `session/` — Session persistence, LRU eviction, archiving
- `eventbus/` — Internal event bus
- `server/` — HTTP routes and middleware
- `clawless/` — Web API client (calls back to AgentBoster Web)
- `config/` — Configuration loading and validation
- `certs/` — mTLS certificate management
- `identity/` — Daemon identity and pairing
- `lifecycle/` — Startup/shutdown orchestration
- `metrics/` — Runtime metrics collection
- `persistence/` — Local state persistence
- `cache/` — Internal caching

## Database Schema (Drizzle)

Tables: `sessions`, `messages`, `files`, `longTermMemories`, `longTermMemoryChunks`, `sessionMemories`, `builtinMemories`, `scheduledTasks`, `agentTasks`, `agentTaskOutputs`, `agentReviewLogs`, `agentL0Rules`, `agentSandboxes`, `agentMemories`, `notifications`, `notificationPreferences`, `channelHealth`.

Schema source: `lib/core/db/schema/`. Export barrel: `lib/core/db/schema/index.ts`.

## CI

- GitHub Actions: `.github/workflows/lint.yml` (verify on push/PR).
- Docs: `.github/workflows/docs-pages.yml` (deploys `.docs/` to GitHub Pages on main).

## Gotchas

- `.env.local` is gitignored — create it with `DATABASE_URL` and `REDIS_URL` for local dev.
- The `postbuild` script only runs Drizzle push on Vercel production builds (checks `VERCEL` + `VERCEL_ENV`/`VERCEL_TARGET_ENV`).
- `middleware.ts` matcher excludes `_next/static`, `_next/image`, `favicon.ico`, and `.well-known/workflow/` — workflow callbacks bypass auth.
- The `useImport` style is turned off in Biome (`useImportType: "off"`). Don't auto-fix imports to `import type`.
- `noExplicitAny` is `"warn"` (not error) in Biome config.
- CI uses **Yarn** (not Bun) to run checks: `yarn run check`.
- **Vercel Workflow constraints**: Node.js modules (`node:fs`, `node:path`, etc.) cannot be used in workflow functions. All file I/O must be wrapped in `'use step'` functions. Functions calling agentd (like `execToolOnAgentd`, `checkAgentdHealth`) use `'use step'` and read certificates inside the step.
