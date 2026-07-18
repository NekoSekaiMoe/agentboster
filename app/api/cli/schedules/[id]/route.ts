/**
 * PATCH  /api/cli/schedules/[id]
 * DELETE /api/cli/schedules/[id]
 *
 * Update or delete a scheduled task. Mirrors
 * `updateScheduleTaskAction` / `deleteScheduleTaskAction` from
 * `app/(schedule)/actions.ts` but as a JSON API for the Desktop
 * client. Both handlers are scoped to the caller via
 * `getScheduledTask(id, { userId })` — a 404 is returned when the
 * task belongs to another user or does not exist.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import {
  deleteScheduledTask,
  getScheduledTask,
  updateScheduledTask,
} from '@/lib/core/db/scheduled';
import { createLogger } from '@/lib/utils/logger';
import { scheduledTaskWorkflow } from '@/lib/workflow/scheduled';
import {
  computeNextDailyRunAt,
  getDefaultScheduleTimezone,
  parseDelayTarget,
  validateTimezone,
} from '@/lib/workflow/scheduled/utils';
import { getRun, start } from 'workflow/api';
import { z } from 'zod';

const logger = createLogger('api.cli.schedules.id');

const baseTaskSchema = z.object({
  title: z.string().trim().min(1).nullable().optional(),
  prompt: z.string().trim().min(1),
  active: z.boolean().default(true),
});

const delayTaskSchema = baseTaskSchema.extend({
  type: z.literal('delay'),
  runAt: z.iso.datetime(),
  notifyChannel: z.string().trim().optional().nullable(),
  remoteControl: z.boolean().optional(),
});

const dailyTaskSchema = baseTaskSchema.extend({
  type: z.literal('daily'),
  dailyTime: z.string().trim().min(1),
  timezone: z.string().trim().min(1).optional(),
  notifyChannel: z.string().trim().optional().nullable(),
  remoteControl: z.boolean().optional(),
});

const updateSchema = z.discriminatedUnion('type', [
  delayTaskSchema,
  dailyTaskSchema,
]);

function getTaskIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/schedules\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

async function cancelScheduleRun(runId: string | null | undefined) {
  if (!runId) {
    return;
  }
  try {
    await getRun(runId).cancel();
  } catch (error) {
    logger.warn('schedule:cancel_run_failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function notFound() {
  return Response.json({ ok: false, error: 'Task not found' }, { status: 404 });
}

export const PATCH = withCliAuth(async (request, { userId }) => {
  const taskId = getTaskIdFromUrl(request);
  if (!taskId) {
    return Response.json(
      { ok: false, error: 'Missing task id.' },
      { status: 400 },
    );
  }

  const existing = await getScheduledTask(taskId, { userId });
  if (!existing) {
    return notFound();
  }

  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error:
          parsed.error.issues[0]?.message ?? 'Invalid schedule task payload.',
      },
      { status: 400 },
    );
  }

  const task = parsed.data;
  const now = new Date();
  const notifyChannel = task.notifyChannel?.trim() || null;
  const remoteControl = task.remoteControl ?? false;

  const normalized =
    task.type === 'delay'
      ? {
          type: 'delay' as const,
          timezone: null,
          dailyTime: null,
          nextRunAt: parseDelayTarget({ runAt: task.runAt, now }),
          metadata: { runAt: task.runAt },
        }
      : {
          type: 'daily' as const,
          timezone: validateTimezone(
            task.timezone ?? getDefaultScheduleTimezone(),
          ),
          dailyTime: task.dailyTime,
          nextRunAt: computeNextDailyRunAt({
            dailyTime: task.dailyTime,
            timeZone: task.timezone ?? getDefaultScheduleTimezone(),
            now,
          }),
          metadata: {
            timezone: task.timezone ?? getDefaultScheduleTimezone(),
            dailyTime: task.dailyTime,
          },
        };

  await cancelScheduleRun(existing.scheduleWorkflowRunId);

  await updateScheduledTask(
    taskId,
    {
      type: normalized.type,
      title: task.title ?? null,
      prompt: task.prompt,
      timezone: normalized.timezone,
      dailyTime: normalized.dailyTime,
      nextRunAt: normalized.nextRunAt,
      active: task.active,
      metadata: normalized.metadata,
      notifyChannel,
      remoteControl,
      scheduleWorkflowRunId: null,
    },
    { userId },
  );

  if (task.active) {
    const run = await start(scheduledTaskWorkflow, [taskId]);
    await updateScheduledTask(
      taskId,
      { scheduleWorkflowRunId: run.runId },
      { userId },
    );
  }

  return Response.json({ ok: true });
});

export const DELETE = withCliAuth(async (request, { userId }) => {
  const taskId = getTaskIdFromUrl(request);
  if (!taskId) {
    return Response.json(
      { ok: false, error: 'Missing task id.' },
      { status: 400 },
    );
  }

  const existing = await getScheduledTask(taskId, { userId });
  if (!existing) {
    return notFound();
  }

  await cancelScheduleRun(existing.scheduleWorkflowRunId);
  await deleteScheduledTask(taskId, { userId });

  return Response.json({ ok: true });
});
