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
  // Node-routing overrides (same shape as POST). Allowed on PATCH so
  // the user can re-pick a preferred node or toggle auto-fallback
  // without recreating the task.
  preferredNodeId: z.string().trim().min(1).nullable().optional(),
  allowedNodes: z.array(z.string().trim().min(1)).nullable().optional(),
  autoFallbackNode: z.boolean().optional(),
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

async function cancelScheduleRun(
  runId: string | null | undefined,
): Promise<void> {
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
    throw new Error(
      `Failed to cancel previous schedule run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const preferredNodeId = task.preferredNodeId?.trim() || null;
  const allowedNodesRaw = task.allowedNodes ?? null;
  const allowedNodes =
    allowedNodesRaw && allowedNodesRaw.length > 0 ? allowedNodesRaw : null;
  const autoFallbackNode = task.autoFallbackNode ?? false;

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
      preferredNodeId,
      allowedNodes,
      autoFallbackNode,
      scheduleWorkflowRunId: null,
      // When the user explicitly re-enables a task (active=true via
      // PATCH) reset the consecutive-failure counter and clear the
      // auto-disable flag — give the task a fresh start. Re-disabling
      // (active=false) leaves the counter intact so the next enable
      // still starts from zero by definition.
      ...(task.active ? { failureCount: 0, disabledByFailure: false } : {}),
    },
    { userId },
  );

  if (task.active) {
    let run: Awaited<ReturnType<typeof start>>;
    try {
      run = await start(scheduledTaskWorkflow, [taskId]);
    } catch (startError) {
      // Start failed — mark the task inactive so it doesn't read as
      // "active but unscheduled", and surface the error. The previous
      // run was already cancelled, so we don't need to cancel again.
      await updateScheduledTask(taskId, { active: false }, { userId }).catch(
        (markError) => {
          logger.warn('schedule:patch:mark_inactive_failed', {
            taskId,
            error:
              markError instanceof Error
                ? markError.message
                : String(markError),
          });
        },
      );
      throw startError;
    }

    try {
      await updateScheduledTask(
        taskId,
        { scheduleWorkflowRunId: run.runId },
        { userId },
      );
    } catch (updateError) {
      // runId write failed — cancel the orphan run so it doesn't fire
      // untracked, and mark the task inactive.
      try {
        await getRun(run.runId).cancel();
      } catch (cancelError) {
        logger.warn('schedule:patch:cancel_orphan_failed', {
          runId: run.runId,
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        });
      }
      await updateScheduledTask(taskId, { active: false }, { userId }).catch(
        () => {
          // best-effort
        },
      );
      throw updateError;
    }
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

  // Cancel the live run first. If cancellation fails we MUST NOT delete the
  // task row — otherwise the orphaned run will fire against a missing task
  // and there will be no handle to retry cancellation later.
  await cancelScheduleRun(existing.scheduleWorkflowRunId);

  await deleteScheduledTask(taskId, { userId });

  return Response.json({ ok: true });
});
