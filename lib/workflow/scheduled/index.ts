import { assertBotAuthSecret, getAppBaseUrl } from '@/lib/bot/webhook';
import { getScheduledTask, updateScheduledTask } from '@/lib/core/db/scheduled';
import { createLogger } from '@/lib/utils/logger';
import { ofetch } from 'ofetch';
import { sleep } from 'workflow';
import { computeNextDailyRunAt, getDefaultScheduleTimezone } from './utils';

const logger = createLogger('workflow.scheduled');

async function readScheduledTask(taskId: string) {
  'use step';

  return getScheduledTask(taskId);
}

async function persistNextRunAt(taskId: string, nextRunAt: Date | null) {
  'use step';

  await updateScheduledTask(taskId, { nextRunAt });
}

async function postScheduledTrigger(taskId: string, scheduledFor: string) {
  'use step';

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
  if (!task || !task.active) {
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
    if (!current || !current.active || current.type !== 'daily') {
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
    await postScheduledTrigger(current.id, nextRunAt.toISOString());
  }
}
