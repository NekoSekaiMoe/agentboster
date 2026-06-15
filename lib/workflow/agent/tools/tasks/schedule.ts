import {
  createScheduledTask,
  updateScheduledTask,
} from '@/lib/core/db/scheduled';
import { scheduledTaskWorkflow } from '@/lib/workflow/scheduled';
import {
  computeNextDailyRunAt,
  getDefaultScheduleTimezone,
  parseDelayTarget,
  validateTimezone,
} from '@/lib/workflow/scheduled/utils';
import { tool } from 'ai';
import { start } from 'workflow/api';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const baseTaskSchema = {
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
};

const delayTaskSchema = z.object({
  ...baseTaskSchema,
  runAt: z.iso.datetime().optional(),
  delaySeconds: z
    .number()
    .int()
    .positive()
    .max(3 * 24 * 60 * 60)
    .optional(),
});

const dailyTaskSchema = z.object({
  ...baseTaskSchema,
  dailyTime: z.string().min(1),
  timezone: z.string().min(1).optional(),
});

async function createScheduledWorkflowRunStep({
  targetSessionId,
  title,
  prompt,
  type,
  timezone,
  dailyTime,
  nextRunAt,
  metadata,
}: {
  targetSessionId: string;
  title?: string;
  prompt: string;
  type: 'delay' | 'daily';
  timezone?: string;
  dailyTime?: string;
  nextRunAt: Date;
  metadata: Record<string, string | number | null>;
}) {
  'use step';

  const task = await createScheduledTask({
    sessionId: targetSessionId,
    type,
    title,
    prompt,
    timezone,
    dailyTime,
    nextRunAt,
    metadata,
  });

  const run = await start(scheduledTaskWorkflow, [task.id]);
  await updateScheduledTask(task.id, {
    scheduleWorkflowRunId: run.runId,
  });

  return {
    ok: true,
    taskId: task.id,
    sessionId: task.sessionId,
    type: task.type,
    prompt: task.prompt,
    nextRunAt: nextRunAt.toISOString(),
    timezone: timezone ?? null,
    dailyTime: dailyTime ?? null,
    scheduleWorkflowRunId: run.runId,
  };
}

export default defineBuildInTool({
  id: 'schedule',
  description: `Create delayed tasks (within 3 days) or daily recurring tasks that later trigger the normal chat workflow.`,
  factory: async (_config, { sessionId }) => {
    return {
      dailyTask: tool({
        title: 'Daily Task',
        description: `Create a daily recurring task. Provide dailyTime in HH:mm format and optionally a timezone.`,
        inputSchema: dailyTaskSchema,
        execute: async (value) => {
          const now = new Date();
          const timezone = validateTimezone(
            value.timezone ?? getDefaultScheduleTimezone(),
          );
          const nextRunAt = computeNextDailyRunAt({
            dailyTime: value.dailyTime,
            timeZone: timezone,
            now,
          });

          return createScheduledWorkflowRunStep({
            targetSessionId: sessionId,
            title: value.title,
            prompt: value.prompt,
            type: 'daily',
            timezone,
            dailyTime: value.dailyTime,
            nextRunAt,
            metadata: {
              timezone,
              dailyTime: value.dailyTime,
            },
          });
        },
      }),
      delayTask: tool({
        title: 'Delay Task',
        description: `Create a one-time delayed task. Provide either runAt or delaySeconds, with a maximum delay of 3 days.`,
        inputSchema: delayTaskSchema,
        execute: async (value) => {
          const now = new Date();
          const nextRunAt = parseDelayTarget({
            runAt: value.runAt,
            delaySeconds: value.delaySeconds,
            now,
          });

          return createScheduledWorkflowRunStep({
            targetSessionId: sessionId,
            title: value.title,
            prompt: value.prompt,
            type: 'delay',
            nextRunAt,
            metadata: {
              runAt: nextRunAt.toISOString(),
              requestedDelaySeconds: value.delaySeconds ?? null,
            },
          });
        },
      }),
    };
  },
});
