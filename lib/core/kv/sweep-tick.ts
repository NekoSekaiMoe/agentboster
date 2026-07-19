/**
 * Throttled driver for the self-hosted KV sweep.
 *
 * `sweepExpiredKv()` (in ./pg-backend) physically deletes expired rows from
 * `kv_store` / `kv_sets`. Lazy expiry (the `liveRow()` filter on reads) keeps
 * behavior correct without it, but nothing bounds table growth — expired rows
 * accumulate until swept. We piggyback the sweep on the agentd heartbeat path
 * (see app/api/agentd/v1/nodes/heartbeat/route.ts) so no external scheduler or
 * Vercel cron is needed, mirroring how reapStaleNodes() rides the same beat.
 *
 * Two guards keep it cheap:
 *  - Self-hosted only. On Vercel the KV backend is Upstash Redis, which expires
 *    keys natively; the pg KV tables don't even exist there. `isSelfHosted`
 *    gates the whole thing.
 *  - In-process time throttle. Heartbeats arrive every ~30s PER node, so a
 *    busy cluster would otherwise hammer two DELETEs many times a minute for
 *    no benefit. We run the sweep at most once per SWEEP_MIN_INTERVAL_MS per
 *    process. The throttle is best-effort (module-level timestamp, not a
 *    distributed lock) — a few redundant sweeps across instances are harmless
 *    since the DELETE is idempotent.
 *
 * IMPORTANT: this module is only imported from the heartbeat route (a Node
 * runtime handler), never from the workflow bundle, but it still avoids
 * top-level `node:*` imports out of caution — it only touches ./pg-backend
 * (drizzle) and ../deploy (pure env reader).
 */
import { isSelfHosted } from '@/lib/extra/deploy';

/** Minimum wall-clock gap between physical sweeps in a single process. */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;

let _lastSweepAt = 0;
let _inFlight: Promise<number> | null = null;

/**
 * Run the KV sweep if we're self-hosted and enough time has elapsed since the
 * last one. Returns the number of rows deleted, or 0 when skipped (Vercel,
 * throttled, or a sweep already in flight). Never throws — callers on the
 * heartbeat path must not be broken by a sweep failure.
 */
export async function maybeSweepExpiredKv(
  now: number = Date.now(),
): Promise<number> {
  if (!isSelfHosted) return 0;
  if (_inFlight) return 0;
  if (now - _lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;

  // Claim the window before awaiting so concurrent heartbeats in the same
  // process don't all pass the time check and fan out into parallel sweeps.
  _lastSweepAt = now;
  _inFlight = (async () => {
    try {
      const { sweepExpiredKv } = await import('./pg-backend');
      return await sweepExpiredKv();
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}
