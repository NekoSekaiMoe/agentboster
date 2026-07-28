/**
 * Dream orchestrator — the top-level entry point that runs the offline
 * memory consolidation pipeline for one user.
 *
 * Flow (P0 — Phase 1 only):
 *
 *   consolidate  ──►  sanitize  ──►  apply  ──►  audit row
 *   (phase1)         (phase3)       (apply)     (dream_runs)
 *
 * Phase 2 (recombine / propose novel findings) is intentionally absent
 * in P0; the orchestrator is shaped so it slots in between phase1 and
 * phase3 without touching the apply path.
 *
 * Trigger model (see design doc):
 *   External cron → POST /api/cron/dream (CRON_SECRET) → fan out to one
 *   orchestrator invocation per active user. Each invocation is a single
 *   async function — no long-lived scheduler process, so it runs equally
 *   well on Vercel (serverless function) and self-hosted (systemd timer).
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/orchestrator.py
 * ::execute_dream_pass.
 */

import { randomUUID } from 'node:crypto';

import { getConfig } from '@/lib/core/kv/config';
import {
  completeDreamRun,
  insertDreamRun,
} from '@/lib/core/db/memory/dream-runs';
import { listAllLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

import { applyDreamOperations } from './apply';
import type { DreamOperation } from './types';
import { consolidatePhase } from './phase1-consolidate';
import type { MemoryRow } from './phase2-recombine';
import { recombinePhase } from './phase2-recombine';
import { sanitizeOperations } from './phase3-sanitize';

const logger = createLogger('memory.dream.orchestrator');

export interface DreamRunOutcome {
  runId: string;
  userId: string;
  phases: string;
  consolidated: number;
  deleted: number;
  kept: number;
  proposed: number;
  rejectedDuplicates: number;
  applied: number;
  skipped: number;
  failed: number;
}

/**
 * Run the Dream pipeline for one user.
 *
 * Each phase is isolated: a throw in phase1 still records an audit row
 * with `failed > 0` rather than swallowing the error silently. The
 * caller (the cron route / manual trigger) decides how to surface
 * failures.
 *
 * @param input.userId  the user whose memories to consolidate
 * @param input.config  optional config override (loaded from KV otherwise)
 */
export async function runDreamForUser(input: {
  userId: string;
  config?: AppConfig;
}): Promise<DreamRunOutcome> {
  const config = input.config ?? (await getConfig());
  const runId = randomUUID();
  const startedAt = new Date();
  const phasesRun: string[] = [];

  // Default outcome — returned even on early failure so the caller sees a
  // consistent shape.
  const outcome: DreamRunOutcome = {
    runId,
    userId: input.userId,
    phases: '',
    consolidated: 0,
    deleted: 0,
    kept: 0,
    proposed: 0,
    rejectedDuplicates: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
  };

  // Pre-insert the audit row so a crashed run is still visible in the UI
  // (finishedAt null + result indicating where it stopped).
  let auditRow = await insertDreamRun({
    userId: input.userId,
    startedAt,
    finishedAt: null,
    phases: '',
    operations: [],
    result: { stage: 'started', error: null },
  }).catch((error) => {
    logger.error('orchestrator:audit_insert_failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  try {
    // ─── Phase 1: consolidate ──────────────────────────────────────────
    // Pre-fetch the user's active memories ONCE and share them across
    // phase1 + phase2. Each phase used to call listAllLongTermMemoryRows
    // itself, which scanned the user's full memory store twice per run.
    const sharedMemories = (await listAllLongTermMemoryRows({
      userId: input.userId,
    }).catch((error) => {
      logger.warn('orchestrator:prefetch_failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    })) as MemoryRow[] | null;

    phasesRun.push('phase1');
    const phase1 = await consolidatePhase({
      userId: input.userId,
      config,
      ...(sharedMemories ? { memories: sharedMemories } : {}),
    });
    outcome.consolidated = phase1.stats.consolidated;
    outcome.deleted = phase1.stats.deleted;
    outcome.kept = phase1.stats.kept;
    outcome.rejectedDuplicates += phase1.stats.rejectedDuplicates;

    let operations: DreamOperation[] = phase1.operations;

    // ─── Phase 2: recombine (cross-cluster novel findings) ────────────
    // Run AFTER consolidate so proposals can build on freshly-merged
    // canonical facts rather than the noisy pre-consolidation set. Failures
    // here are non-fatal: a failed recombine just yields no PROPOSE ops,
    // and the rest of the pipeline continues.
    phasesRun.push('phase2');
    try {
      const phase2 = await recombinePhase({
        userId: input.userId,
        config,
        ...(sharedMemories ? { memories: sharedMemories } : {}),
      });
      outcome.proposed = phase2.stats.proposed;
      operations = operations.concat(phase2.operations);
    } catch (error) {
      logger.warn('orchestrator:phase2_skipped', {
        runId,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // ─── Phase 3: sanitize (near-dup collapse, self-supersede guard) ──
    phasesRun.push('phase3');
    const phase3 = sanitizeOperations(operations);
    operations = phase3.accepted;
    outcome.rejectedDuplicates += phase3.rejectedDuplicates;

    // ─── Apply ─────────────────────────────────────────────────────────
    phasesRun.push('apply');
    const applyResult = await applyDreamOperations({
      userId: input.userId,
      operations,
      config,
    });
    outcome.applied = applyResult.applied;
    outcome.skipped = applyResult.skipped;
    outcome.failed = applyResult.failed;

    outcome.phases = phasesRun.join('+');

    logger.info('orchestrator:done', {
      runId,
      userId: input.userId,
      phases: outcome.phases,
      consolidated: outcome.consolidated,
      rejectedDuplicates: outcome.rejectedDuplicates,
      applied: outcome.applied,
      failed: outcome.failed,
    });

    return outcome;
  } catch (error) {
    outcome.failed += 1;
    outcome.phases = `${phasesRun.join('+')}<crashed>`;
    const message = error instanceof Error ? error.message : String(error);
    logger.error('orchestrator:crashed', {
      runId,
      userId: input.userId,
      stage: phasesRun[phasesRun.length - 1] ?? 'unknown',
      error: message,
    });

    // Re-throw so the caller can mark the trigger failed, but the audit
    // row (updated below in finally) still records partial progress.
    throw error;
  } finally {
    const finishedAt = new Date();
    if (auditRow) {
      auditRow = await completeDreamRun({
        id: auditRow.id,
        finishedAt,
        operations: [], // P0: operations provenance tracked via dream_runs.result
        result: {
          phases: outcome.phases,
          consolidated: outcome.consolidated,
          deleted: outcome.deleted,
          kept: outcome.kept,
          proposed: outcome.proposed,
          rejectedDuplicates: outcome.rejectedDuplicates,
          applied: outcome.applied,
          skipped: outcome.skipped,
          failed: outcome.failed,
        },
      }).catch((error) => {
        logger.warn('orchestrator:audit_complete_failed', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return auditRow;
      });
    }
  }
}
