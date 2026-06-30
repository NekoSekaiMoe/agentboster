import { createLogger } from '@/lib/utils/logger';
import { sleep } from 'workflow';
import { computeNextDailyRunAt, getDefaultScheduleTimezone } from './utils';

const logger = createLogger('workflow.scheduled');

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
    if (task.nextRunAt && task.nextRunAt.getTime() > Date.now()) {
      await sleep(task.nextRunAt);
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

  while (true) {
    const current = await readScheduledTask(taskId);
    if (!current?.active || current.type !== 'daily') {
      return {
        taskId,
        status: 'stopped',
      };
    }

    const nextRunAt = computeNextDailyRunAt({
      dailyTime: current.dailyTime ?? '09:00',
      timeZone: current.timezone ?? getDefaultScheduleTimezone(),
    });

    await persistNextRunAt(current.id, nextRunAt);
    logger.info('daily:scheduled', {
      taskId: current.id,
      nextRunAt: nextRunAt.toISOString(),
    });

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
