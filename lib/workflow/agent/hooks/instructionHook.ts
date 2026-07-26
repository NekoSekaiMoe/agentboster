import type { UserMessagePart } from '@/types/workflow';
import { defineHook } from 'workflow';
import { z } from 'zod';

export const instructionHookSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    message: z.string(),
    parts: z.array(z.custom<UserMessagePart>()).optional(),
    uiMessageId: z.string().optional(),
  }),
  z.object({
    type: z.literal('system'),
    message: z.string(),
  }),
  z.object({
    type: z.literal('control'),
    command: z.enum(['compact', 'cancel', 'checkpoint']),
    reason: z.string().optional(),
    /**
     * Label for a checkpoint command. Optional — when omitted the workflow
     * auto-labels the checkpoint with its step number. Ignored for non-
     * checkpoint commands.
     */
    label: z.string().optional(),
  }),
]);

export const instructionHookBuilder = defineHook({
  schema: instructionHookSchema,
});
