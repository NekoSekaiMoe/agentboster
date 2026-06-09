import { z } from 'zod';

export const chatConfigSchema = z.object({
  enter_to_send: z.boolean().default(true),
  follow_up_enabled: z.boolean().default(false),
});

export type ChatConfig = z.infer<typeof chatConfigSchema>;
