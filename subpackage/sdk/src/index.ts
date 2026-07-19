/**
 * @agentboster/sdk — cross-tier SDK unifying public types and contracts
 * across the AgentBoster platform's three deployable tiers (CLI, Web,
 * Desktop) and the agentd execution daemon.
 *
 * The SDK is organized into five surfaces. Each surface mirrors the
 * public contract of one source-of-truth location in the repo; runtime
 * implementations stay in their own tier. The SDK is a curated view,
 * not a fork — never import across tiers from SDK code.
 *
 * ## Surfaces
 *
 * - **CLI runtime** (`./cli.js`) — extension/skill/prompt/theme authoring,
 *   tool/agent primitives, session lifecycle. Re-exported from
 *   `@agentboster-cli/core`; runtime injects real types via jiti.
 * - **Web HTTP API** (`./web.js`) — auth (cookie / CLI token / agentd-key /
 *   signed URL), SSE events, request/response shapes for `/api/cli/*` and
 *   `/api/agentd/v1/*` routes.
 * - **Workflow DevKit** (`./workflow.js`) — step chunks (`WorkflowUIMessageChunk`),
 *   hook payloads, message persistence shapes, dispatch facade types.
 * - **Desktop IPC & bridge** (`./desktop.js`) — Tauri `invoke` command map,
 *   RPC bridge messages, `AppSettings`, workspace state, tray/window events.
 * - **Agentd tool protocol** (`./agentd.js`) — `APIResponse<T>` envelope,
 *   tool exec / SSE stream, sandbox profiles, L0/L1/L2 security events,
 *   node register/heartbeat wire.
 *
 * ## Standalone type-check
 *
 * Each surface has its own stub under `vendor/<surface>/` so the SDK
 * type-checks without the cli workspace, the `ai` package, or other
 * runtime peers installed. Real types are injected by the host at load.
 *
 * ## Compatibility helpers
 *
 * SDK-only helpers (cross-version shims) live in `./compat.js`.
 *
 * @packageDocumentation
 */

// ── Surface aggregation ───────────────────────────────────────────
// Each surface owns its own subdirectory + regen path; this file is
// only the package entry point. To add a new surface, create
// `src/<surface>/index.ts` and re-export it here.

// CLI surface is re-exported flat at the package root for backwards
// compatibility — extensions written against earlier SDK versions do
// `import { ExtensionAPI, Type } from '@agentboster/sdk'` and should
// keep working without qualification.
export * from './cli';

// The newer Web / Workflow / Desktop / Agentd surfaces are re-exported
// as namespaces to avoid name collisions with the flat CLI surface
// (e.g. both CLI and Desktop happen to export `RpcSessionState`;
// both CLI and Agentd export `ToolDefinition`). Namespace imports also
// make call-site intent clearer: `import { web } from '@agentboster/sdk'`
// signals the consumer is targeting the Web HTTP API contract.
export * as web from './web';
export * as workflow from './workflow';
export * as desktop from './desktop';
export * as agentd from './agentd';

// ── SDK-only compatibility helpers ──────────────────────────────
export { resolveModelApiKey } from './compat';
