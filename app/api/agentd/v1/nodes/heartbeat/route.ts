export const dynamic = 'force-dynamic';

import { reapStaleNodes } from '@/lib/extra/agent/node-liveness';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const logger = createLogger('api.agentd.nodes.heartbeat');

interface CgroupStat {
  sandbox_id?: string;
  cpu_usec?: number;
  memory_current?: number;
  memory_peak?: number;
  pids_current?: number;
}

/**
 * Aggregate per-sandbox cgroup samples into per-node totals.
 *
 *   - sandbox_mem_current_total = Σ memory.current (excluding -1)
 *   - sandbox_mem_peak_total    = Σ memory.peak (excluding -1)
 *   - sandbox_cpu_usec_total    = Σ cpu.stat usage_usec (monotonic counter)
 *
 * Samples with sentinel -1 (cgroup v1 host / unreadable path) are
 * skipped so they don't drag the totals to a meaningless value. When
 * every sample is sentinel we return null for all three —
 * NodeSelector treats null as "no cgroup data" and falls back to
 * host-level metrics.
 */
function aggregateCgroupStats(
  samples: CgroupStat[] | null | undefined,
): {
  sandboxMemCurrentTotal: number | null;
  sandboxMemPeakTotal: number | null;
  sandboxCpuUsecTotal: number | null;
} {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      sandboxMemCurrentTotal: null,
      sandboxMemPeakTotal: null,
      sandboxCpuUsecTotal: null,
    };
  }

  let memCurrentTotal = 0;
  let memPeakTotal = 0;
  let cpuUsecTotal = 0;
  let sawAny = false;

  for (const s of samples) {
    if (!s) continue;
    if (typeof s.memory_current === 'number' && s.memory_current >= 0) {
      memCurrentTotal += s.memory_current;
      sawAny = true;
    }
    if (typeof s.memory_peak === 'number' && s.memory_peak >= 0) {
      memPeakTotal += s.memory_peak;
      sawAny = true;
    }
    if (typeof s.cpu_usec === 'number' && s.cpu_usec >= 0) {
      cpuUsecTotal += s.cpu_usec;
      sawAny = true;
    }
  }

  if (!sawAny) {
    return {
      sandboxMemCurrentTotal: null,
      sandboxMemPeakTotal: null,
      sandboxCpuUsecTotal: null,
    };
  }

  return {
    sandboxMemCurrentTotal: memCurrentTotal,
    sandboxMemPeakTotal: memPeakTotal,
    sandboxCpuUsecTotal: cpuUsecTotal,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      node_id,
      cpu_model,
      cpu_usage,
      mem_avail,
      disk_avail,
      active_tasks,
      active_sandboxes,
      cgroup_stats,
    } = body;

    if (!node_id) {
      return Response.json(
        { success: false, error: 'Missing node_id' },
        { status: 400 },
      );
    }

    const cgroupAggregates = aggregateCgroupStats(cgroup_stats);

    await db
      .update(agentdNodes)
      .set({
        cpuModel: cpu_model,
        cpuUsage: cpu_usage != null ? Math.round(cpu_usage * 100) : null,
        memAvail: mem_avail != null ? Math.round(mem_avail * 100) : null,
        diskAvail: disk_avail != null ? Math.round(disk_avail * 100) : null,
        activeTasks: active_tasks ?? 0,
        activeSandboxes: active_sandboxes ?? 0,
        sandboxMemCurrentTotal: cgroupAggregates.sandboxMemCurrentTotal,
        sandboxMemPeakTotal: cgroupAggregates.sandboxMemPeakTotal,
        sandboxCpuUsecTotal: cgroupAggregates.sandboxCpuUsecTotal,
        lastHeartbeat: new Date(),
        status: 'online',
      })
      .where(eq(agentdNodes.nodeID, node_id));

    // Piggyback a stale-node reaper on every heartbeat. agentd pings
    // every 30s, so this doubles as a lazy sweeper without requiring an
    // external scheduler. Best-effort: failures here must not fail the
    // heartbeat (the caller would back off and retry).
    try {
      const reaped = await reapStaleNodes();
      if (reaped.markedOffline > 0 || reaped.deletedZombies > 0) {
        logger.info('reaped stale agentd nodes', reaped);
      }
    } catch (reapError) {
      logger.warn('stale-node reap failed (non-fatal)', {
        error: reapError instanceof Error ? reapError.message : String(reapError),
      });
    }

    return Response.json({
      success: true,
      accepted: true,
    });
  } catch (error) {
    logger.error('heartbeat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Heartbeat failed' },
      { status: 500 },
    );
  }
}
