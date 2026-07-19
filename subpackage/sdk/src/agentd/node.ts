// agentd node register + heartbeat protocol.
//
// Sources of truth:
//   - subpackage/agentd/internal/lifecycle/lifecycle.go:295-379 —
//     register request, register response, heartbeat request.
//   - subpackage/agentd/internal/metrics/metrics.go:43-55 —
//     `AgentCgroupStat` (per-sandbox cgroup v2 sample).
//   - lib/extra/agent/node-liveness.ts — heartbeat cutoff constants
//     and `computeNodeStatus` effective-status helper (Web side).
//
// Drift is reported by `scripts/regen-agentd.py`.

import type { SandboxProfile } from './sandbox.js';

// Source: subpackage/agentd/internal/lifecycle/lifecycle.go:295-303
/**
 * Node registration request, sent by the daemon to the Web's
 * `/api/agentd/v1/nodes/register` endpoint on startup. The Web side
 * dedups by `node_id` first, then by `(ip, port)` — a daemon that
 * lost its persisted `node_id` file (host reboot wiped `/var/run/`)
 * reclaims the stale row by address rather than creating a
 * duplicate (see `lib/extra/agent/node-liveness.ts:findNodeByAddress`).
 */
export interface NodeRegisterRequest {
  node_id: string;
  ip: string;
  port: string | number;
  sandboxes?: SandboxProfile[];
  version?: string;
}

// Source: subpackage/agentd/internal/lifecycle/lifecycle.go:307-310
/**
 * Node registration response. `interval` is the heartbeat cadence
 * (in seconds) the Web tier instructs the daemon to use; the
 * daemon's local config default (30s) applies when the Web omits it.
 */
export interface NodeRegisterResponse {
  node_id: string;
  /** Heartbeat interval in seconds. */
  interval: number;
}

// Source: subpackage/agentd/internal/metrics/metrics.go:47-55
/**
 * Per-sandbox cgroup v2 resource sample, forwarded inside the
 * heartbeat payload. All counters default to `-1` on cgroup v1 hosts
 * or when the cgroup path can't be resolved — consumers should
 * treat `-1` as "no data" and skip scoring.
 */
export interface AgentCgroupStat {
  agent_id?: string;
  sandbox_id?: string;
  sandbox_type?: string;
  cpu_usec?: number;
  memory_current?: number;
  memory_peak?: number;
  pids_current?: number;
}

// Source: subpackage/agentd/internal/lifecycle/lifecycle.go:368-379
/**
 * Node heartbeat payload, sent on a fixed cadence (default 30s) to
 * the Web's `/api/agentd/v1/nodes/heartbeat` endpoint. The Web side
 * uses `cpu_usage` / `mem_avail` / `active_sandboxes` /
 * `cgroup_stats` to drive `selectBestNode` in
 * `lib/workflow/agent/dispatch.ts`.
 *
 * `timestamp` is a Unix epoch integer (not ISO8601) on the wire —
 * matches the daemon's `time.Now().Unix()` emission.
 */
export interface NodeHeartbeatRequest {
  node_id: string;
  cpu_model?: string;
  cpu_usage?: number;
  mem_avail?: number;
  disk_avail?: number;
  active_tasks?: number;
  active_sandboxes?: number;
  /** Map of agentId → live sandbox count for this node. */
  per_agent?: Record<string, number>;
  cgroup_stats?: AgentCgroupStat[];
  /** Unix epoch seconds. */
  timestamp?: number;
}

// Source: lib/extra/agent/node-liveness.ts:13
/**
 * Heartbeat staleness window. A node is considered online only if
 * its last heartbeat is within this window. With agentd's 30s
 * default heartbeat interval, 2 minutes ≈ 4 missed beats.
 *
 * Matches the dispatch path's rule
 * (`lib/workflow/agent/dispatch.ts:selectBestNode`).
 */
export const NODE_HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;

// Source: lib/extra/agent/node-liveness.ts:21
/**
 * Hard cutoff for zombie node reaping. Rows whose last heartbeat is
 * older than this are deleted outright by `reapStaleNodes()`, since
 * a re-register with a fresh `node_id` always creates a new row
 * (the `(ip, port)` dedup in the register route reclaims live
 * rows, not zombies).
 */
export const NODE_ZOMBIE_CUTOFF_MS = 24 * 60 * 60 * 1000;

// Source: lib/extra/agent/node-liveness.ts:59-66
/**
 * Effective node status, computed from the stored `status` column
 * (advisory — only ever written `'online'`) and `lastHeartbeat`
 * freshness. This is what read endpoints should expose; raw
 * `agentd_nodes.status` is **not** a liveness signal on its own.
 */
export type NodeStatus = 'online' | 'offline';
