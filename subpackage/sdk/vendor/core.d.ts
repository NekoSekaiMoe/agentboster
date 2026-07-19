// Type stub for `@agentboster-cli/core`.
//
// The real types live in
//   subpackage/cli/packages/coding-agent/src/core/extensions/types.ts
// and are re-exported from coding-agent's package entry. The runtime
// injects the module via a virtual-module alias at load time, so
// extensions get the real types automatically.
//
// SDK-local type-check uses this stub because the SDK is a standalone
// package (it must type-check without the cli workspace installed).
// `export type *` would be ideal, but it doesn't work inside
// `declare module`, so we declare the two value exports the SDK
// re-exports plus a wildcard-ish ExtensionFactory placeholder. The
// real shape is enforced when the SDK is consumed inside an actual
// extension that has the runtime as a peer dep.

export type ExtensionFactory = (api: unknown) => void | Promise<void>;
export const defineTool: <T>(...args: unknown[]) => T;
export function isToolCallEventType(value: unknown): boolean;

