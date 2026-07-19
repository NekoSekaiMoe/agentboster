/**
 * Desktop IPC surface — types for the Tauri-backed AgentBoster Desktop
 * app.
 *
 * Re-exports the five modules that together cover the Desktop public
 * contract:
 *   - `settings.ts`  — `AppSettings` (persisted settings.json shape).
 *   - `invoke.ts`    — Typed Tauri command map + `makeTypedInvoke`.
 *   - `rpc.ts`       — RPC bridge types (`RpcStartOptions`,
 *                      `RpcSessionState`, MCP service shapes, etc.).
 *   - `events.ts`    — Tauri event payloads (`DesktopEventMap`).
 *   - `workspace.ts` — Renderer workspace state (`WorkspaceState`,
 *                      `SessionRuntime`, `CliInstallState`).
 *
 * Source-of-truth for each module is named in its file header. Run
 * `scripts/regen-desktop.py` to detect drift against the Desktop
 * source tier.
 *
 * @example Typed invoke
 * ```ts
 * import { invoke } from '@tauri-apps/api/core';
 * import { makeTypedInvoke } from '@agentboster/sdk/desktop';
 *
 * const invokeTyped = makeTypedInvoke(invoke);
 * const { discovery } = await invokeTyped('rpc_start', {
 *   options: {
 *     cli_path: null, pi_path: null, cwd: '/repo',
 *     provider: null, model: null, env: null,
 *     session_id: null, backend_url: null,
 *   },
 * });
 * ```
 */
export * from './settings.js';
export * from './invoke.js';
export * from './rpc.js';
export * from './events.js';
export * from './workspace.js';
