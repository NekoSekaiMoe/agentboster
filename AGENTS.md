# AGENTS.md

Compact guide for OpenCode sessions in this repo. Keep it short: only include facts that are easy to miss from filenames and scripts.

## Repo shape

- Root is the Web app (`Next.js 15.5` + `React 19` + `TypeScript 6`) and uses `yarn`.
- `agentd/` is a separate Go 1.26 module with its own `AGENTS.md`; `cli/` is a separate npm workspace with its own docs and scripts.
- `@/*` maps to the repo root (`tsconfig.json` and `vitest.config.ts`); prefer it over long relative imports.
- `ref/` is vendored reference material and is ignored by root TypeScript/Biome; do not edit it as app code.

## Commands

- `yarn dev` starts Next dev (`withWorkflow` is part of the build, so workflow code is always in play).
- `yarn build` runs `next build`; it does **not** enforce type or lint correctness.
- `yarn lint:check` is the real gate before shipping: `tsc --noEmit && biome check .`.
- `yarn test` runs Vitest; a single file can be targeted with `yarn test <path>` or `yarn test:watch <path>`.
- Vitest only picks up `lib/**/*.test.ts`, `app/**/*.test.ts`, `hooks/**/*.test.ts`, `components/**/*.test.{ts,tsx}`, and `cli/src/**/*.test.ts`.
- `yarn publish` is the canonical ship script, but `package.json` still points it at `yarn run check`; run `yarn lint:check` manually instead.
- DB commands need `DATABASE_URL`: `yarn db:generate`, `yarn db:push`, `yarn db:studio`, `yarn db:ensure-vector`.

## Web gotchas

- `next.config.ts` ignores ESLint and TypeScript build errors, so build output alone is not a quality check.
- `postbuild` only touches the database when `VERCEL=1` and `VERCEL_ENV=production`; local builds will not migrate anything.
- `middleware.ts` protects all routes unless they are explicitly bypassed; new `app/api/**` routes are gated by default.
- Daemon callbacks under `/api/agentd/v1/*` and `/api/soul/*` use mTLS + `AGENTD_API_KEY`, not the user session.
- Workflow code runs in a sandbox without `fetch`, `__dirname`, `Buffer`, or direct DB access; any host-only helper reached from a workflow body must be marked `'use step'`.
- Do not import `next/server` or `next/headers` from workflow tree code; that has already broken on `__dirname` access.
- Use `createLogger` from `lib/utils/logger.ts` for server logging; avoid `console.log` in server code.

## Style and infra

- Biome is the only formatter/linter here (`biome.jsonc`); do not run import sorters because `organizeImports` is off.
- The repo intentionally tolerates some Biome rules as warnings/off; do not “fix” disabled a11y or style rules unless the code itself needs it.
- `next.config.ts` keeps several packages external to avoid bundle breakage, including `playwright`, `zlib-sync`, and chat adapters.
- The custom SVG icons exist for coverage gaps; use `lucide-react` for new icons unless the repo already has a bespoke asset.

## Useful pointers

- `README.md` is the best high-level map; `cli/README.md` and `agentd/README.md` are the boundaries for those subprojects.
- `MULTI-NODE-SCHEDULING.md` matters before touching multi-node dispatch logic.
- `.agents/skills/` contains repo-local OpenCode skills; load the matching skill instead of re-deriving its rules.
