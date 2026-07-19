// Web HTTP API surface — public re-exports.
//
// Aggregates the four hand-ported modules (auth, envelope, sse, routes)
// so consumers can `import { AuthSession, CliResult, ... } from
// '@agentboster/sdk/web'` once the top-level `src/index.ts` is wired
// (the top-level barrel is assembled separately — do not edit it here).
//
// Drift between this surface and the Web tier source is detected by
// `scripts/regen-web.py`.

export * from './auth.js';
export * from './envelope.js';
export * from './sse.js';
export * from './routes.js';
