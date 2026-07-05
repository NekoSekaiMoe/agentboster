import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const BARRIER_MODES = ['all', 'quorum', 'first_ok', 'first_fail'] as const;

const baseSchema = {
  barrierId: z
    .string()
    .min(1)
    .describe(
      'The stable barrier id returned by create. Required for release/wait/cancel/status.',
    ),
};

const createSchema = z.object({
  action: z.literal('create').default('create'),
  expected: z
    .number()
    .int()
    .positive()
    .describe(
      'How many distinct participants must release() before the barrier fires.',
    ),
  mode: z
    .enum(BARRIER_MODES)
    .default('all')
    .describe(
      '`all` = every expected participant must release (default). ' +
        '`quorum` = at least `quorum` ok-releases required. ' +
        '`first_ok` = the first ok-release fires the barrier. ' +
        '`first_fail` = the first failed release fires the barrier (fail-fast).',
    ),
  quorum: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Required when mode=`quorum`. The minimum number of ok-releases needed.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe(
      'Optional hard deadline in milliseconds. After this elapses with ' +
        'no satisfying release, the barrier is marked expired. Default 10 minutes.',
    ),
});

const releaseSchema = z.object({
  action: z.literal('release').default('release'),
  barrierId: z.string().min(1),
  participantId: z
    .string()
    .min(1)
    .describe(
      'Logical name of the releasing participant. Must be unique per ' +
        'barrier — calling release twice with the same id is a no-op.',
    ),
  ok: z
    .boolean()
    .describe(
      'true if the participant succeeded. The barrier aggregates ok ' +
        'values to compute the final result based on its mode.',
    ),
  payload: z
    .unknown()
    .optional()
    .describe(
      'Optional result data this participant is contributing. Surfaced ' +
        'verbatim in the released snapshot for the caller to aggregate.',
    ),
});

const waitSchema = z.object({
  action: z.literal('wait').default('wait'),
  barrierId: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe(
      'In-process wait cap. If the barrier is still open after this, ' +
        'wait returns the current (open) snapshot. Default 10 minutes.',
    ),
});

const cancelSchema = z.object({
  action: z.literal('cancel').default('cancel'),
  ...baseSchema,
  reason: z.string().optional(),
});

const statusSchema = z.object({
  action: z.literal('status').default('status'),
  ...baseSchema,
});

const unifiedSchema = z.discriminatedUnion('action', [
  createSchema,
  releaseSchema,
  waitSchema,
  cancelSchema,
  statusSchema,
]);

export default defineBuildInTool({
  id: 'barrier',
  description:
    'Durable synchronization primitive for multi-agent coordination. ' +
    'Create a barrier with N expected participants, have each ' +
    'participant call release() when done, and call wait() to block ' +
    'until the release condition is met. Survives workflow restarts ' +
    'and can be released by participants in other processes (e.g. ' +
    'scheduled tasks, separate workflow runs).',
  factory: async (_config, context) => {
    return {
      barrier: tool({
        title: 'Multi-Agent Barrier',
        description:
          'Coordinate N parallel participants. Actions: ' +
          '`create` opens a barrier with an expected participant count and ' +
          'a release mode; `release` is called by each participant on ' +
          'completion; `wait` blocks the calling step until the barrier ' +
          'fires; `cancel` force-terminates an open barrier; `status` ' +
          'returns the current snapshot. The barrier persists across ' +
          'workflow restarts — waiters rehydrate from the DB on boot.',
        inputSchema: unifiedSchema,
        execute: async (input) => {
          // Dynamic import: the BarrierRegistry pulls in DB helpers that
          // must not be top-level dependencies of the workflow bundle.
          const { getBarrierRegistry } = await import(
            '@/lib/workflow/agent/barrier'
          );
          const registry = getBarrierRegistry();

          if (input.action === 'create') {
            const barrierId = await registry.create({
              sessionId: context.sessionId,
              runId: context.runId,
              expected: input.expected,
              mode: input.mode,
              quorum: input.quorum,
              expiresAt: input.timeoutMs
                ? new Date(Date.now() + input.timeoutMs)
                : undefined,
            });
            return { ok: true, action: 'create', barrierId };
          }

          if (input.action === 'release') {
            const snapshot = await registry.release({
              barrierId: input.barrierId,
              participantId: input.participantId,
              ok: input.ok,
              payload: input.payload,
            });
            if (!snapshot) {
              return {
                ok: false,
                action: 'release',
                error: `Barrier ${input.barrierId} not found.`,
              };
            }
            return {
              ok: true,
              action: 'release',
              barrier: snapshot,
            };
          }

          if (input.action === 'wait') {
            const snapshot = await registry.waitFor(
              input.barrierId,
              input.timeoutMs,
            );
            if (!snapshot) {
              return {
                ok: false,
                action: 'wait',
                error: `Barrier ${input.barrierId} not found.`,
              };
            }
            return {
              ok: true,
              action: 'wait',
              barrier: snapshot,
            };
          }

          if (input.action === 'cancel') {
            const snapshot = await registry.cancel({
              barrierId: input.barrierId,
              reason: input.reason,
            });
            if (!snapshot) {
              return {
                ok: false,
                action: 'cancel',
                error: `Barrier ${input.barrierId} not found.`,
              };
            }
            return {
              ok: true,
              action: 'cancel',
              barrier: snapshot,
            };
          }

          // action === 'status'
          const cached = registry.peek(input.barrierId);
          if (!cached) {
            return {
              ok: false,
              action: 'status',
              error: `Barrier ${input.barrierId} not in cache. It may have expired or been created in a different process.`,
            };
          }
          return {
            ok: true,
            action: 'status',
            barrier: cached,
          };
        },
      }),
    };
  },
});
