import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const putSchema = z.object({
  action: z.literal('put').default('put'),
  key: z
    .string()
    .min(1)
    .describe(
      'Logical name for this handoff within the session, e.g. "research_result" or "plan_v3". ' +
        'Takers filter by this key.',
    ),
  payload: z
    .unknown()
    .describe(
      'The data being handed off. Any JSON-serializable value is fine.',
    ),
  toSessionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Target session. Omit for broadcast (any session may take it). ' +
        'Use this to send a result to a specific other chat/workflow.',
    ),
  barrierId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional barrier to release() after the put succeeds. Use this to ' +
        'unblock a coordinator that is waiting on waitForBarrier. The ' +
        'release uses participantId "put:<key>".',
    ),
});

const takeSchema = z.object({
  action: z.literal('take').default('take'),
  key: z.string().min(1),
  broadcastsOnly: z
    .boolean()
    .default(false)
    .describe(
      'true = only consume broadcast handoffs (toSessionId unset). false ' +
        '(default) = also consume handoffs explicitly targeted at this session.',
    ),
  barrierId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional barrier to release() after the take succeeds (whether or ' +
        'not a handoff was found). The release uses participantId "take:<key>".',
    ),
});

const peekSchema = z.object({
  action: z.literal('peek').default('peek'),
  key: z.string().min(1),
  broadcastsOnly: z.boolean().default(false),
});

const listSchema = z.object({
  action: z.literal('list_sent').default('list_sent'),
});

const handoffSchema = z.discriminatedUnion('action', [
  putSchema,
  takeSchema,
  peekSchema,
  listSchema,
]);

export default defineBuildInTool({
  id: 'handoff',
  description:
    'Durable mailbox for cross-session and cross-workflow agent messages. ' +
    'Put a named payload (optionally targeted at another session, optionally ' +
    'releasing a linked barrier) and take/peek it later — even from a ' +
    'different chat thread or workflow run. Survives process restarts.',
  factory: async (_config, context) => {
    return {
      handoff: tool({
        title: 'Cross-Session Handoff',
        description:
          'Asynchronous named mailbox for cross-session collaboration. ' +
          '`put` deposits a payload under a key; `take` does a destructive ' +
          'read of the oldest matching row (returns null if nothing is ' +
          'waiting); `peek` is a non-destructive list; `list_sent` shows ' +
          'everything the current session has emitted. Use a `barrierId` ' +
          'to unblock a coordinator that is waiting via the barrier tool.',
        inputSchema: handoffSchema,
        execute: async (input) => {
          // Dynamic imports keep this module's deps out of the workflow
          // bundle's static analysis graph.
          const {
            putHandoff,
            takeHandoff,
            peekHandoffs,
            listHandoffsByFromSession,
            releaseLinkedBarrier,
          } = await import('@/lib/core/db/agent-handoffs');

          if (input.action === 'put') {
            const row = await putHandoff({
              fromSessionId: context.sessionId,
              toSessionId: input.toSessionId,
              runId: context.runId,
              barrierId: input.barrierId,
              key: input.key,
              payload: input.payload,
            });
            if (input.barrierId) {
              await releaseLinkedBarrier(
                input.barrierId,
                `put:${input.key}`,
                true,
                { handoffId: row.id, key: input.key },
              );
            }
            return {
              ok: true,
              action: 'put',
              handoffId: row.id,
              key: row.key,
              toSessionId: row.toSessionId ?? null,
              barrierId: row.barrierId ?? null,
            };
          }

          if (input.action === 'take') {
            const row = await takeHandoff({
              forSessionId: context.sessionId,
              key: input.key,
              broadcastsOnly: input.broadcastsOnly,
            });
            if (input.barrierId) {
              await releaseLinkedBarrier(
                input.barrierId,
                `take:${input.key}`,
                true,
                row
                  ? { handoffId: row.id, key: input.key }
                  : { key: input.key, empty: true },
              );
            }
            if (!row) {
              return {
                ok: true,
                action: 'take',
                empty: true,
                key: input.key,
              };
            }
            return {
              ok: true,
              action: 'take',
              handoffId: row.id,
              key: row.key,
              fromSessionId: row.fromSessionId ?? null,
              toSessionId: row.toSessionId ?? null,
              payload: row.payload,
              createdAt: row.createdAt.toISOString(),
            };
          }

          if (input.action === 'peek') {
            const rows = await peekHandoffs({
              forSessionId: context.sessionId,
              key: input.key,
              broadcastsOnly: input.broadcastsOnly,
            });
            return {
              ok: true,
              action: 'peek',
              key: input.key,
              count: rows.length,
              handoffs: rows.map((r) => ({
                handoffId: r.id,
                fromSessionId: r.fromSessionId ?? null,
                toSessionId: r.toSessionId ?? null,
                payload: r.payload,
                createdAt: r.createdAt.toISOString(),
              })),
            };
          }

          // action === 'list_sent'
          const rows = await listHandoffsByFromSession(context.sessionId);
          return {
            ok: true,
            action: 'list_sent',
            count: rows.length,
            handoffs: rows.map((r) => ({
              handoffId: r.id,
              key: r.key,
              toSessionId: r.toSessionId ?? null,
              payload: r.payload,
              createdAt: r.createdAt.toISOString(),
            })),
          };
        },
      }),
    };
  },
});
