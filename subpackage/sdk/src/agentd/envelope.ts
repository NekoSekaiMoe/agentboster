// agentd HTTP API — response envelope.
//
// Source of truth: subpackage/agentd/internal/clawless/types.go (Go
// generic `APIResponse[T]`). Every daemon endpoint returns this shape,
// whether the underlying handler succeeded or failed. The web tier's
// `/api/agentd/v1/**` routes mirror the same envelope — when the Web
// tier proxies through to a node, the inner `data` is the node's raw
// response payload.
//
// Hand-ported as a structural interface so the SDK type-checks without
// depending on the Go source. Drift is reported by
// `scripts/regen-agentd.py`.

// Source: subpackage/agentd/internal/clawless/types.go:318-323
/**
 * Standard agentd HTTP response envelope.
 *
 * All daemon endpoints (`/api/v1/**` on the daemon, and the mirrored
 * `/api/agentd/v1/**` on the Web tier) return this shape. `success`
 * is the authoritative discriminator; `data` is present on success,
 * `error` on failure.
 *
 * Generic parameter `T` is the type of `data` on success. Use
 * `APIResponse<MyPayload>` to narrow a fetch response in one cast.
 *
 * Mirrors `APIResponse[T any]` in `clawless/types.go`.
 */
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
