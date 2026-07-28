import { createLogger } from '@/lib/utils/logger';
import { sleep } from 'workflow';
import { computeNextDailyRunAt, getDefaultScheduleTimezone } from './utils';

const logger = createLogger('workflow.scheduled');

/**
 * How long a daily task's slot can be in the past before we treat it as a
 * misfire worth logging + alerting on. A few seconds of skew (workflow
 * runtime wake-up latency) is normal; minutes+ means the host was down.
 *
 * Mirrors APScheduler's `misfire_grace_time` concept but inverted: we
 * ALWAYS run the missed job (coalesce=True semantics — only the latest
 * missed slot fires), and use this threshold only to flag it as a
 * misfire vs. a normal on-time wake.
 */
const MISFIRE_THRESHOLD_MS = 60 * 1000;

async function readScheduledTask(taskId: string) {
  'use step';

  const { getScheduledTask } = await import('@/lib/core/db/scheduled');
  return getScheduledTask(taskId);
}

async function persistNextRunAt(taskId: string, nextRunAt: Date | null) {
  'use step';

  const { updateScheduledTask } = await import('@/lib/core/db/scheduled');
  await updateScheduledTask(taskId, { nextRunAt });
}

async function postScheduledTrigger(taskId: string, scheduledFor: string) {
  'use step';

  const { assertBotAuthSecret, getAppBaseUrl } = await import(
    '@/lib/bot/webhook'
  );
  const { ofetch } = await import('ofetch');
  const response = await ofetch.raw(
    `${getAppBaseUrl()}/api/bot/${assertBotAuthSecret()}/schedule`,
    {
      method: 'POST',
      body: {
        taskId,
        scheduledFor,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Scheduled callback failed with status ${response.status}.`,
    );
  }

  return response._data;
}

export async function scheduledTaskWorkflow(taskId: string) {
  'use workflow';

  const task = await readScheduledTask(taskId);
  if (!task?.active) {
    return {
      taskId,
      status: 'inactive',
    };
  }

  if (task.type === 'delay') {
    // Misfire detection for delay tasks: a nextRunAt in the past means
    // the workflow runtime woke up late (host restart, long step queue).
    // We always fire immediately rather than skipping — matches
    // APScheduler's coalesce=True + misfire_grace_time=None policy.
    // The misfire is logged + recorded on metadata so operators can
    // spot chronically late tasks (e.g. a host that reboots every hour
    // during the slot).
    if (task.nextRunAt) {
      const delayMs = Date.now() - task.nextRunAt.getTime();
      if (delayMs > MISFIRE_THRESHOLD_MS) {
        logger.warn('delay:misfire', {
          taskId: task.id,
          scheduledFor: task.nextRunAt.toISOString(),
          delayMs,
        });
        await persistMisfire(task.id, delayMs);
      } else if (delayMs > 0) {
        await sleep(task.nextRunAt);
      }
    }

    await postScheduledTrigger(
      task.id,
      (task.nextRunAt ?? new Date()).toISOString(),
    );

    return {
      taskId: task.id,
      status: 'completed',
      type: task.type,
    };
  }

  // daily task: a long-lived while-loop that fires once per day at the
  // configured local time. Misfire handling is coalesce=True: if the
  // host was down across multiple slots (e.g. down from Mon 09:00 to
  // Wed 10:00), we fire ONCE for the latest missed slot then advance
  // to tomorrow — we do NOT replay Tue + Wed + Thu separately.
  while (true) {
    const current = await readScheduledTask(taskId);
    if (!current?.active || current.type !== 'daily') {
      return {
        taskId,
        status: 'stopped',
      };
    }

    const now = Date.now();
    const storedNextRunAt = current.nextRunAt?.getTime() ?? null;

    const nextRunAt = computeNextDailyRunAt({
      dailyTime: current.dailyTime ?? '09:00',
      timeZone: current.timezone ?? getDefaultScheduleTimezone(),
    });

    // Misfire detection: if the previously-persisted nextRunAt is more
    // than MISFIRE_THRESHOLD_MS in the past, the host missed its slot.
    // Coalesce: we still fire now (once), then advance to tomorrow.
    // Without this log/metadata hook the misfire would be silent — the
    // sleep(nextRunAt) below returns immediately when nextRunAt is in
    // the past, so the trigger fires, but nothing distinguishes a
    // healthy on-time run from a 3-day-late catch-up.
    if (storedNextRunAt !== null) {
      const misfireDelayMs = now - storedNextRunAt;
      if (misfireDelayMs > MISFIRE_THRESHOLD_MS) {
        logger.warn('daily:misfire', {
          taskId: current.id,
          scheduledFor: new Date(storedNextRunAt).toISOString(),
          delayMs: misfireDelayMs,
          // Human-readable "N missed slots" for daily cadence — helps
          // operators gauge severity (1 missed slot vs. a week).
          missedSlots: Math.floor(misfireDelayMs / (24 * 60 * 60 * 1000)),
        });
        await persistMisfire(current.id, misfireDelayMs);
      }
    }

    await persistNextRunAt(current.id, nextRunAt);
    logger.info('daily:scheduled', {
      taskId: current.id,
      nextRunAt: nextRunAt.toISOString(),
    });

    // sleep with a past deadline returns immediately — that's the
    // coalesce path (misfire catch-up). Otherwise we wait until the slot.
    await sleep(nextRunAt);
    try {
      await postScheduledTrigger(current.id, nextRunAt.toISOString());
    } catch (error) {
      // postScheduledTrigger is a 'use step' — once its internal retries
      // are exhausted, the runtime rejects its promise with FatalError.
      // Without this catch the FatalError bubbles to the workflow body
      // and the entire daily run enters 'failed' state, silently killing
      // every future fire of this task.
      //
      // Daily frequency is the right cadence for retry: a transient
      // outage (chat backend 5xx, DB connection blip) at 09:00 should
      // not spam retries at 09:00:04 / 09:00:08 — it should just wait
      // for the next day's slot. Swallow, log, let the while loop
      // advance to the next computeNextDailyRunAt().
      logger.error('daily:trigger_failed', {
        taskId: current.id,
        scheduledFor: nextRunAt.toISOString(),
        error,
      });
    }
  }
}

/**
 * Persist a misfire event onto the task's metadata.misfire field.
 *
 * We keep a bounded rolling window (last 5 misfires) so operators can see
 * a pattern (e.g. "always misfires around 03:00" → backup job contention)
 * without unbounded growth. Resets the array's `consecutiveCount` so the
 * most recent misfire burst is visible at a glance.
 */
async function persistMisfire(taskId: string, delayMs: number) {
  'use step';

  const { getScheduledTask, updateScheduledTask } = await import(
    '@/lib/core/db/scheduled'
  );
  const task = await getScheduledTask(taskId);
  if (!task) return;

  const meta = (task.metadata ?? {}) as {
    misfire?: {
      consecutiveCount?: number;
      lastAt?: string;
      lastDelayMs?: number;
      history?: Array<{ at: string; delayMs: number }>;
    };
  };

  const prev = meta.misfire;
  // Heuristic: if the previous misfire was within 2x the daily cadence,
  // treat it as the same outage burst (consecutive). Otherwise reset.
  // For delay-type tasks this is approximate but good enough for alerting.
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const prevAt = prev?.lastAt ? Date.parse(prev.lastAt) : NaN;
  const isConsecutive =
    Number.isFinite(prevAt) && Date.now() - prevAt < twoDaysMs;

  const consecutiveCount =
    (isConsecutive ? (prev?.consecutiveCount ?? 0) : 0) + 1;
  const entry = { at: new Date().toISOString(), delayMs };
  const history = [...(prev?.history ?? []), entry].slice(-5);

  await updateScheduledTask(taskId, {
    metadata: {
      ...meta,
      misfire: {
        consecutiveCount,
        lastAt: entry.at,
        lastDelayMs: delayMs,
        history,
      },
    },
  });
}
