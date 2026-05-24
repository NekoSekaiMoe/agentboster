# AgentBoster — Agent Instructions

## What This Repo Is

A serverless AI agent platform ("ClawLess" / "AgentBoster") with two halves:

- **`app/` + `lib/` + `types/`** — Next.js 15 web app (App Router, RSC), deployed to Vercel. This is the primary codebase in this repo.
- **`agentd/`** — Go daemon for Linux servers (sandbox execution, security). Separate build/deploy pipeline.

## Tech Stack (Verified)

- **Runtime:** Node.js (Next.js 15.5.9, React 19)
- **Package manager:** Yarn (see `package.json` scripts)
- **CI:** Bun (`bun install`, `bun tsc --noEmit && bun biome check`) — see `.github/workflows/lint.yml`
- **DB:** Neon Postgres via Drizzle ORM (`lib/core/db/index.ts`). Drizzle schema at `lib/core/db/schema/`.
- **Cache/KV:** Upstash Redis (`lib/core/kv/index.ts`)
- **Storage:** Vercel Blob (`lib/core/blob/`)
- **Sandbox:** Vercel Sandbox (`lib/core/sandbox/`)
- **Workflow:** Vercel Workflow DevKit (`lib/workflow/`)
- **AI SDK:** Vercel AI SDK 6, Chat SDK
- **Linting/Formatting:** Biome 1.9.4 (`biome.jsonc`). NOT ESLint, NOT Prettier.
- **TypeScript:** strict mode, `@/*` path alias maps to repo root
- **UI:** Tailwind CSS 3, shadcn/ui, Framer Motion, Radix UI

## Commands

```bash
yarn install          # install dependencies
yarn dev              # start dev server (next dev)
yarn build            # production build (next build)
yarn check            # tsc --noEmit && biome check . --write
yarn format           # biome format . --write
yarn lint:fix         # biome lint . --write --unsafe
yarn postbuild        # db migration (runs automatically after build on Vercel production)
yarn db:generate      # drizzle-kit generate
yarn db:push          # drizzle-kit push
yarn db:studio        # drizzle-kit studio
```

`yarn check` is the main verification command — typecheck + lint + auto-fix in one step.

## Architecture: Two Library Layers

### `lib/core/` — Active, production code
The real implementation used at runtime:

| Path | Purpose |
|---|---|
| `lib/core/db/` | Drizzle ORM database layer (Neon Postgres). Schema, chat CRUD, memory, files, scheduled tasks, agentd tables, notifications. |
| `lib/core/kv/` | Upstash Redis: app config, skills index/details, distributed locks |
| `lib/core/blob/` | Vercel Blob: skill file storage, git clone + sync |
| `lib/core/sandbox/` | Vercel Sandbox lifecycle: create/reuse/stop, session runtime metadata |

### `lib/extra/` — Legacy / Agent Daemon counterpart
A parallel implementation (`AuthProvider`, `PostgresProvider`, `MongoDBProvider`, `ChannelManager`, `NotificationManager`, prompt fragment builders) that mirrors what the Go agent daemon does. **Not imported by the Next.js app at runtime.** The web app uses `lib/core/` instead. Do not wire `lib/extra/` into web routes without understanding the duplication.

### `lib/workflow/` — Vercel Workflow DevKit orchestration
- `lib/workflow/agent/index.ts` — `chatWorkflow`: the main agent loop using `DurableAgent` from `@workflow/ai`
- `lib/workflow/agent/dispatch.ts` — `startWorkflow`, `resumeWithMessage`, `pauseWorkflow`, `resumeToolApproval`
- `lib/workflow/agent/hooks/` — `instructionHook` (user/system/control messages into a running workflow) and `approvalHook` (L2 tool approval)
- `lib/workflow/agent/steps/` — prompt building, message persistence, context compaction, run finalization
- `lib/workflow/agent/tools/` — tool definitions (sandbox exec, file ops, memory, skills, sub-agent, MCP)

## Data Flow (Chat)

1. User sends message → `POST /api/ai` (or IM webhook → `routeAdapterMessage()`)
2. `chatMain()` in `lib/chat/index.ts` — resolves/creates session, persists user message, starts/resumes workflow
3. `startWorkflow()` → Vercel Workflow DevKit runs `chatWorkflow()` as a durable workflow
4. Workflow uses `DurableAgent` with AI SDK, streams responses back
5. Session state (workflow phase, sandbox status, approvals) stored in `sessions.metadata` JSONB column

## Database Schema (Key Tables)

All in `lib/core/db/schema/`:

| Table | Purpose |
|---|---|
| `sessions` | Chat sessions. Key fields: `id`, `channel`, `externalThreadId`, `model`, `status`, `workflowRunId`, `sandboxId`, `totalTokens`, `metadata` (JSONB for runtime state) |
| `messages` | Chat messages. Key fields: `sessionId`, `role` (user/assistant/summary/tool/system), `uiMessageId`, `visibleInChat`, `stepNumber`, `payload` (JSONB) |
| `long_term_memories` + `long_term_memory_chunks` | RAG memory with vector (`embedding` column, pgvector) + keyword (`tsv` tsvector) hybrid search |
| `session_memories` | Per-session context summaries for compaction |
| `builtin_memories` | AGENTS/SOUL/IDENTITY/USER sections (keyed enum) |
| `files` | File records linked to sessions, stored in Vercel Blob |
| `scheduled_tasks` | Cron/delay tasks (`delay` or `daily` types) |
| `agent_tasks`, `agent_review_logs`, `agent_l0_rules`, `agent_sandboxes`, `agent_memories` | Agent daemon task tracking |
| `notifications`, `notification_preferences`, `channel_health` | IM notification delivery tracking |

## Environment Variables (Required)

- `DATABASE_URL` — Neon Postgres connection string
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Upstash Redis
- `AUTH_SECRET`, `USERNAME`, `PASSWORD` — Auth config (checked at login page)
- `VERCEL` / `VERCEL_ENV` — Used by `postbuild` script to decide whether to run Drizzle migrations

## Postbuild / DB Migration

`yarn postbuild` runs `scripts/vercel-postbuild.ts` which:
1. Only runs on Vercel production builds
2. Ensures `pgvector` extension exists
3. Runs `drizzle-kit push` to apply schema changes

If you see database schema errors locally, run `yarn db:push` manually.

## Conventions

- **No ESLint/Prettier** — Biome handles both lint and format. Config in `biome.jsonc`.
- **Path alias:** `@/*` maps to repo root (e.g., `@/lib/core/db`)
- **JSONB columns** use `.$type<T>()` for type safety with Drizzle
- **Session metadata** is a JSONB blob storing nested `workflow.*` and `sandbox.*` runtime state — accessed via `getSessionRuntimeMetadata()` in `lib/core/sandbox/runtime.ts`
- **Skills** are stored in Vercel Blob with metadata in Redis KV. Two sources: `git` (cloned from repo) and `manual` (user-uploaded).
- **The `types/` directory** at repo root contains shared Zod schemas and TypeScript types. `AppConfig` (the master config schema) is in `types/config/index.ts`.
- **Legacy `lib/extra/auth`** uses in-memory user store — the web app uses a different auth mechanism (JWT cookies, see `lib/extra/auth/` vs the login page at `app/(auth)/login/page.tsx`).

## Gotchas

- `lib/extra/db` has its own `PostgresProvider`/`MongoDBProvider` — but the actual app uses Drizzle via `lib/core/db`. The `extra` providers are not wired up.
- CI uses **Bun**, not Node/Yarn. Local dev uses Yarn. Both should work.
- The `package.json` name is `"clawless"` — the project was renamed to AgentBoster but the package name wasn't updated.
- `generateUUID()` in `lib/utils/index.ts` uses `Math.random()` — not cryptographically secure. Fine for client-side message IDs, don't use for security tokens.
- `next.config.ts` uses `withWorkflow()` wrapper from `workflow/next` — required for Vercel Workflow DevKit integration.
