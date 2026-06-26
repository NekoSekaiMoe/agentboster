import { defineHook } from 'workflow';
import { z } from 'zod';

/**
 * Payload schema for the local-tool-result hook.
 *
 * Inside a workflow's `local_*` tool execute (see
 * lib/workflow/agent/tools/local/index.ts), the tool emits a
 * `tool-local-request` chunk to the SSE stream and then blocks on
 * `localToolResultHookBuilder.create({ token: toolCallId })`. The CLI
 * client, which subscribed to the SSE stream, sees the request chunk,
 * executes the tool locally (read/write/exec on the user's machine),
 * and POSTs the result to /api/ai/[runId]/tool-result. That route calls
 * `localToolResultHookBuilder.resume(toolCallId, payload)`, which
 * unblocks the awaiting execute and the workflow loop continues.
 *
 * This mirrors the approval hook (see approvalHook.ts and
 * waitForSandboxApproval in tools/execute/sanbox.ts).
 */
export const localToolResultPayloadSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const localToolResultHookBuilder = defineHook({
  schema: localToolResultPayloadSchema,
});
