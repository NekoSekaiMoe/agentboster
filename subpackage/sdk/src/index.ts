/**
 * @agentboster/sdk — public surface for building agentboster extensions.
 *
 * agentboster extensions are plain TypeScript modules whose default export
 * is an {@link ExtensionFactory}. The runtime loads them via jiti at
 * startup (see `discoverAndLoadExtensions` in the coding-agent package),
 * so this package ships as TypeScript source — no build step required.
 *
 * The types and helpers here are re-exported from `@agentboster-cli/core`
 * (the runtime). Treat this package as the curated, stable subset that
 * external extension authors should target; the runtime re-exports
 * everything else for internal use.
 *
 * @example Minimal extension
 * ```ts
 * import { Type } from 'typebox';
 * import type { ExtensionAPI } from '@agentboster/sdk';
 *
 * export default function (pi: ExtensionAPI): void {
 *   pi.registerTool({
 *     name: 'hello',
 *     label: 'Hello',
 *     description: 'Say hello to someone.',
 *     parameters: Type.Object({ name: Type.Optional(Type.String()) }),
 *     async execute(_id, params) {
 *       return {
 *         content: [{ type: 'text', text: `Hello, ${params.name ?? 'world'}!` }],
 *       };
 *     },
 *   });
 * }
 * ```
 *
 * See `examples/hello-tool/` for a complete working extension.
 *
 * @packageDocumentation
 */

// ── Extension lifecycle ────────────────────────────────────────────
export type * from '@agentboster-cli/core';

// Concrete helpers (values, not types) — explicitly listed so the SDK
// surfaces the curated set. Adding new ones is intentional.
export {
  // Helper for declaring tools with full type inference on params/details.
  defineTool,
  // Type guard for filtering tool-call events.
  isToolCallEventType,
} from '@agentboster-cli/core';

// ── Compatibility helpers ──────────────────────────────────────────
export { resolveModelApiKey } from './compat.js';
