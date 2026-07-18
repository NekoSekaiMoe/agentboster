/**
 * GET  /api/cli/schedules
 * POST /api/cli/schedules
 *
 * List or create scheduled tasks for the caller. The Desktop client
 * uses GET to render the "Scheduled tasks" view and POST to create a
 * new delay/daily task attached to an existing chat session.
 *
 * Both handlers enforce user scoping: tasks are filtered/created
 * against sessions owned by the caller, mirroring
 * `app/(schedule)/actions.ts` but as a JSON API for the CLI.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import {
  serializeScheduledTask,
  type ScheduleTaskRecord,
} from '@/lib/cli/schedule-serialization';
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from '@/lib/core/db/scheduled';
import { getSession } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { scheduledTaskWorkflow } from '@/lib/workflow/scheduled';
import {
  computeNextDailyRunAt,
  getDefaultScheduleTimezone,
  parseDelayTarget,
  validateTimezone,
} from '@/lib/workflow/scheduled/utils';
import { start } from 'workflow/api';
import { z } from 'zod';

const logger = createLogger('api.cli.schedules');

const createSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delay'),
    sessionId: z.string().uuid(),
    title: z.string().trim().min(1).nullable().optional(),
    prompt: z.string().trim().min(1),
    runAt: z.iso.datetime(),
    notifyChannel: z.string().trim().optional().nullable(),
    remoteControl: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('daily'),
    sessionId: z.string().uuid(),
    title: z.string().trim().min(1).nullable().optional(),
    prompt: z.string().trim().min(1),
    dailyTime: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
    notifyChannel: z.string().trim().optional().nullable(),
    remoteControl: z.boolean().optional(),
  }),
]);

export const GET = withCliAuth(async (_req, { userId }) => {
  const tasks = await listScheduledTasks({ userId });
  const serialized: ScheduleTaskRecord[] = tasks.map(serializeScheduledTask);
  return Response.json({ ok: true, tasks: serialized });
});

export const POST = withCliAuth(async (req, { userId }) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
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

  const input = parsed.data;
  const session = await getSession(input.sessionId, { userId });
  if (!session) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 403 },
    );
  }

  const now = new Date();
  const notifyChannel = input.notifyChannel?.trim() || null;
  const remoteControl = input.remoteControl ?? false;

  if (input.type === 'delay') {
    const nextRunAt = parseDelayTarget({ runAt: input.runAt, now });

    const task = await createScheduledTask({
      sessionId: input.sessionId,
      type: 'delay',
      title: input.title ?? undefined,
      prompt: input.prompt,
      nextRunAt,
      metadata: { runAt: input.runAt },
      notifyChannel,
      remoteControl,
    });

    let run: Awaited<ReturnType<typeof start>>;
    try {
      run = await start(scheduledTaskWorkflow, [task.id]);
    } catch (error) {
      // Workflow start failed — roll back the task so we don't leave an
      // active row with no run instance tracking it.
      await deleteScheduledTask(task.id).catch((deleteError) => {
        logger.warn('create:delay:rollback_failed', {
          taskId: task.id,
          error:
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
        });
      });
      throw error;
    }

    await updateScheduledTask(task.id, {
      scheduleWorkflowRunId: run.runId,
    }).catch(async (updateError) => {
      // runId write failed — cancel the orphan run so it doesn't fire
      // untracked, then surface the error.
      try {
        const { getRun } = await import('workflow/api');
        await getRun(run.runId).cancel();
      } catch (cancelError) {
        logger.warn('create:delay:cancel_orphan_failed', {
          runId: run.runId,
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        });
      }
      throw updateError;
    });

    logger.info('create:delay:started', {
      taskId: task.id,
      runId: run.runId,
    });

    // Re-fetch so the response carries the persisted scheduleWorkflowRunId.
    const refreshed = await getScheduledTask(task.id, { userId });
    return Response.json({
      ok: true,
      task: serializeScheduledTask(refreshed ?? task),
    });
  }

  const timeZone = input.timezone ?? getDefaultScheduleTimezone();
  validateTimezone(timeZone);
  const nextRunAt = computeNextDailyRunAt({
    dailyTime: input.dailyTime,
    timeZone,
    now,
  });

  const task = await createScheduledTask({
    sessionId: input.sessionId,
    type: 'daily',
    title: input.title ?? undefined,
    prompt: input.prompt,
    timezone: timeZone,
    dailyTime: input.dailyTime,
    nextRunAt,
    metadata: { timezone: timeZone, dailyTime: input.dailyTime },
    notifyChannel,
    remoteControl,
  });

  let run: Awaited<ReturnType<typeof start>>;
  try {
    run = await start(scheduledTaskWorkflow, [task.id]);
  } catch (error) {
    await deleteScheduledTask(task.id).catch((deleteError) => {
      logger.warn('create:daily:rollback_failed', {
        taskId: task.id,
        error:
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
      });
    });
    throw error;
  }

  await updateScheduledTask(task.id, {
    scheduleWorkflowRunId: run.runId,
  }).catch(async (updateError) => {
    try {
      const { getRun } = await import('workflow/api');
      await getRun(run.runId).cancel();
    } catch (cancelError) {
      logger.warn('create:daily:cancel_orphan_failed', {
        runId: run.runId,
        error:
          cancelError instanceof Error
            ? cancelError.message
            : String(cancelError),
      });
    }
    throw updateError;
  });

  logger.info('create:daily:started', {
    taskId: task.id,
    runId: run.runId,
  });

  // Re-fetch so the response carries the persisted scheduleWorkflowRunId.
  const refreshed = await getScheduledTask(task.id, { userId });
  return Response.json({
    ok: true,
    task: serializeScheduledTask(refreshed ?? task),
  });
});
