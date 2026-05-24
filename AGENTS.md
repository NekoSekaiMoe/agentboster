# ClawLess

Next.js 15 App Router application (React 19, TypeScript) using Bun as the package manager.

## Commands

```bash
bun install          # install dependencies
bun run dev          # start dev server (http://localhost:3000)
bun run check        # typecheck + biome lint/format (CI runs this exact command)
bun run build        # production build
bun run deploy       # deploy to Vercel (vercel --prod)
bun run db:generate  # drizzle-kit generate
bun run db:push      # drizzle-kit push
bun run format       # biome format --write
bun run lint:fix     # biome lint --write --unsafe
```

## Tooling

- **Bun** only — do not use `npm`, `yarn`, or `pnpm` commands.
- **Biome** for linting + formatting (not ESLint/Prettier). Config: `biome.jsonc`.
  - Single quotes, semicolons, trailing commas (`all`), 2-space indent, LF line endings.
  - CSS linting/formatting is **disabled** in Biome.
- **TypeScript** strict mode, `moduleResolution: "bundler"`, path alias `@/*` → `./*`.
- **shadcn/ui** with RSC enabled. Component aliases: `@/components`, `@/lib`, `@/lib/utils`.

## Architecture

```
app/                    # Next.js App Router (RSC by default)
  (auth)/               # auth routes
  (chat)/               # chat routes
  (config)/             # config UI
  (memory)/             # memory management UI
  (skill)/              # skill management UI
  api/                  # API routes (bot webhooks, auth, etc.)

lib/
  ai/                   # AI SDK provider wrappers
  auth/                 # session/cookie auth (bcryptjs, AUTH_COOKIE_NAME)
  bot/                  # bot adapter logic (Slack, Teams, GChat, Telegram)
  chat/                 # chat session/message logic
  core/
    db/
      schema/           # Drizzle schema (chat, files, memory, agentd, notification, scheduled)
      migrations/       # Drizzle migration output
    kv/                 # Upstash Redis client
    sandbox/            # @vercel/sandbox integration
  extra/                # non-core utilities
  memory/               # memory search/retrieval
  utils/                # shared helpers (cn, generateUUID, etc.)
  workflow/             # Vercel Workflow DevKit steps

types/                  # shared TypeScript types
components/
  ui/                   # shadcn/ui primitives
  config/               # config panel components
  *.tsx                 # feature components
scripts/                # tsx scripts (ensure-vector-extension, vercel-postbuild)
```

## Key Conventions

- `'use client'` directive required for any client component. `app/` defaults to RSC.
- Use `ofetch` for HTTP requests (not `fetch` or `axios`).
- Use `@/lib/utils` → `cn()` for conditional class merging (clsx + tailwind-merge).
- Use `zod` for runtime validation. Avoid `any`/`as` casts.
- Import order: external → `@/` internal → relative.
- Drizzle schema entry: `lib/core/db/schema/index.ts`. Config expects `DATABASE_URL`.
- Next.js config wraps with `withWorkflow()` from `workflow/next`.

## Auth & Middleware

- Auth uses cookie-based sessions (`lib/auth/session.ts`). Env vars: `AUTH_SECRET`, `USERNAME`, `PASSWORD`.
- `middleware.ts` protects all routes except `/login`, `/.well-known/workflow/*`, public assets, and `/api/bot/*`.
- Bot routes (`/api/bot/:provider`) bypass auth middleware.

## Database

- **Neon** serverless PostgreSQL via `@neondatabase/serverless` + Drizzle ORM.
- Schema tables: `sessions`, `messages`, `files`, `longTermMemories`, `sessionMemories`, `builtinMemories`, `longTermMemoryChunks`, `agentTasks`, `agentReviewLogs`, `agentL0Rules`, `agentSandboxes`, `agentMemories`, `scheduledTasks`, `notifications`, `notificationPreferences`, `channelHealth`.
- Migrations output to `lib/core/db/migrations/`.
- CI uses Bun 1.3.11.

## AI Integration

- Vercel AI SDK (`ai` package) with providers: Anthropic, Google, OpenAI, OpenAI-compatible.
- React hooks: `@ai-sdk/react` (`useChat`, `useCompletion`).
- MCP support via `@ai-sdk/mcp`.

## Workflow

- Vercel Workflow DevKit (`workflow` package, beta). Inspect via `bun run workflow:inspect`.
- Workflow webhook endpoint: `/.well-known/workflow/*` (always bypasses middleware).

## Deployment

- Vercel. `bun run deploy` runs `vercel --prod`.
- Postbuild script: `scripts/vercel-postbuild.ts` runs after `next build`.
- All pages send `X-Robots-Tag: noindex, nofollow` headers.
