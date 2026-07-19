// agentd sandbox profile types.
//
// Sources of truth:
//   - subpackage/agentd/internal/sandbox/manager.go:140-168 —
//     built-in provider registration (the three tiers).
//   - subpackage/agentd/internal/clawless/types.go:181-188 —
//     `SandboxMeta` wire shape (returned by `/api/v1/sandboxes/:id`).
//   - subpackage/agentd/internal/clawless/types.go:157-165 —
//     per-agent sandbox resource overrides (fields on `AgentConfig`).
//
// Only the wire-exposed surface is mirrored here. The full
// `SandboxConfig` (TOML runtime knobs for the daemon itself) is
// daemon-only and intentionally NOT ported.
//
// Drift is reported by `scripts/regen-agentd.py`.

// Source: subpackage/agentd/internal/sandbox/manager.go:140-168
/**
 * The three tiers of agentd sandbox isolation. Registered by
 * `NewManager` in the daemon:
 *   - `docker` — light tasks (alpine:edge, `--rm`, low resources).
 *   - `docker-strict` — high-risk/untrusted code (no network, RO,
 *     cap-drop ALL).
 *   - `lxc` — persistent containers (default alpine 3.21).
 *
 * Values appear in `ToolExecRequest` / `NodeRegisterRequest` /
 * `SandboxMeta.type` as plain strings; this union is the curated
 * set the daemon registers. Unknown values are passed through as
 * `string` (see `SandboxMeta`).
 */
export type SandboxProfile = 'docker' | 'docker-strict' | 'lxc';

// Source: subpackage/agentd/internal/clawless/types.go:181-188
/**
 * Sandbox metadata, returned by the daemon's `/api/v1/sandboxes/:id`
 * endpoint and stored on the task row for audit. `type` is
 * nominally one of {@link SandboxProfile} but is typed as
 * `SandboxProfile | string` so unknown provider types (custom
 * providers registered via `registerGlobal`) are not truncated.
 */
export interface SandboxMeta {
  id: string;
  agent_id: string;
  type: SandboxProfile | string;
  path?: string;
  status?: string;
  persistent?: boolean;
}

// Source: subpackage/agentd/internal/clawless/types.go:157-165
//
// These five fields live on `AgentConfig` in the Go side; they are
// surfaced separately here so SDK consumers building per-agent
// config payloads (e.g. via the Web's `/api/agentd/v1/config` route)
// can type the sandbox-resource subset without pulling in the full
// `AgentConfig` shape (which is mirrored in `paths.ts`).
/**
 * Per-agent sandbox resource overrides. All fields optional; when
 * unset, the daemon's provider defaults apply.
 *
 * - `sandbox_cpu` — CPU cores limit (e.g. `0.5`, `1.0`).
 * - `sandbox_mem` — Memory quota string (e.g. `"512m"`, `"2g"`).
 * - `sandbox_pids` — Process count cap.
 * - `sandbox_disk` — Disk quota string (e.g. `"1g"`).
 * - `sandbox_blkio_weight` — Block IO weight, 10–1000.
 */
export interface AgentSandboxOverrides {
  sandbox_cpu?: number;
  sandbox_mem?: string;
  sandbox_pids?: number;
  sandbox_disk?: string;
  sandbox_blkio_weight?: number;
}
