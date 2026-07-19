// Web HTTP API — response envelopes.
//
// The Web tier does not have a single global envelope, but two shapes
// coexist in practice:
//   1. The CLI-facing routes (`/api/cli/**`) return `{ ok: true, ... }`
//      on success or `{ ok: false, error }` on failure.
//   2. The agentd-facing routes (`/api/agentd/v1/**`) return
//      `{ success: true, data }` on success or
//      `{ success: false, error }` on failure.
// Both are mirrored here so SDK consumers can narrow a fetch response
// with a discriminated-union type guard.

/**
 * Web CLI route envelope.
 *
 * `ok: true` carries the route's success payload inline; `ok: false`
 * carries a single `error` string. Used by `/api/cli/**`.
 */
export type CliResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Agentd-facing route envelope.
 *
 * `success: true` wraps the payload under `data`; `success: false`
 * carries a single `error` string. Used by `/api/agentd/v1/**`.
 */
export type AgentdResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };
