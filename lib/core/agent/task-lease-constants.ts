/**
 * Lease timing constants, factored into a tiny standalone module so both
 * the DAL (lib/core/db/agentd.ts createTask / updateTaskStatus) and the
 * lease engine (lib/core/agent/task-lease.ts) share one source of truth
 * WITHOUT a circular import.
 *
 * The cycle otherwise: agentd.ts imports TASK_LEASE_SECONDS from
 * task-lease.ts; task-lease.ts imports `db` from @/lib/core/db, whose
 * barrel re-exports agentd.ts. Keeping the constants here breaks it —
 * neither agentd.ts nor task-lease.ts imports the other at module top
 * level for these values.
 */

/**
 * Lease TTL in seconds. A node must heartbeat (and thus renew) within
 * this window or its tasks become reclaimable. agentd's default heartbeat
 * is 30s, so 90s = ~2 missed heartbeats before expiry.
 */
export const TASK_LEASE_SECONDS = 90;

/**
 * Extra slack past lease-expiry (seconds) before a task may be reclaimed.
 * Doubles as the cross-node clock-skew budget. See task-lease.ts.
 */
export const TASK_LEASE_GRACE_SECONDS = 60;
