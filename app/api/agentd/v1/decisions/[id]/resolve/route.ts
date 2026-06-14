/**
 * Decision resolve endpoint (UI-facing).
 *
 * P0.2: Frontend posts to `/api/agentd/v1/decisions/:id/resolve` with
 * a flexible payload shaped by the decision type. Previously this
 * route didn't exist, so all 4 submit handlers in decision-card.tsx
 * silently failed and no decision ever reached the daemon.
 *
 * Payload shapes (per decision-card.tsx):
 *   - L2 auth:  { reply: 'once'|'always'|'reject', answers: [[action]], time_input?, chat_id?, user_id? }
 *   - question: { answers: string[][] }
 *   - conflict: { answers: string[][] }
 *   - branch:   { answers: [[choice]] }
 *
 * The route normalizes all of these into a single `resolve()` call
 * and, for L2 auth, forwards the result to the daemon via
 * forwardL2Confirm so the agent loop unblocks.
 */

import { forwardL2Confirm } from '@/lib/extra/agent/agentd-client';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.decisions.resolve');

const requestSchema = z.object({
  reply: z.string().optional(),
  answers: z.array(z.array(z.string())).optional(),
  time_input: z.string().optional(),
  chat_id: z.string().optional(),
  user_id: z.string().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: decisionId } = await context.params;
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      logger.error('invalid request', {
        decisionId,
        error: parsed.error,
      });
      return Response.json(
        {
          success: false,
          error: 'Invalid request',
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const queue = getDecisionQueue();
    const decision = queue.get(decisionId);
    if (!decision) {
      logger.warn('decision not in cache', { decisionId });
      return Response.json(
        { success: false, error: 'Decision not found' },
        { status: 404 },
      );
    }

    const resolvedBy = parsed.data.user_id ?? 'user';
    const answers = parsed.data.answers;
    const reply = parsed.data.reply ?? '';

    // Normalize action label per decision type.
    let action = 'resolved';
    if (decision.type === 'l2_auth') {
      // reply: 'once' | 'always' | 'reject'
      action =
        reply === 'reject'
          ? 'reject'
          : `pass:${reply === 'always' ? 'always' : 'once'}`;
    } else if (decision.type === 'question') {
      action = 'answered';
    } else if (decision.type === 'conflict') {
      action = 'resolved';
    } else if (decision.type === 'branch') {
      action = 'branch';
    }

    // Reject path → deny(); otherwise resolve().
    if (action === 'reject') {
      await queue.deny(decisionId, resolvedBy);
    } else {
      await queue.resolve(decisionId, action, resolvedBy, answers);
    }

    logger.info('decision resolved', {
      decisionId,
      type: decision.type,
      action,
    });

    // Forward to daemon for L2 auth (the agent loop is blocked waiting).
    // Question/conflict/branch answers go back via the notification
    // callback path (P0.3 will wire that end-to-end).
    if (decision.type === 'l2_auth') {
      const daemonAction =
        reply === 'reject'
          ? parsed.data.reply === 'always'
            ? 'reject_until'
            : 'reject_once'
          : reply === 'always'
            ? 'pass_until'
            : 'pass_once';
      try {
        await forwardL2Confirm({
          task_id: decision.taskId,
          decision_id: decisionId,
          action: daemonAction,
          duration: parsed.data.time_input ?? reply,
        });
      } catch (err) {
        logger.warn('forward to daemon failed; decision still recorded', {
          decisionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return Response.json({
      success: true,
      data: {
        decisionId,
        action,
        message: 'Done',
      },
    });
  } catch (error) {
    logger.error('decision resolve failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Resolve failed' },
      { status: 500 },
    );
  }
}
