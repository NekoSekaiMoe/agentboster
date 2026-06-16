import { z } from 'zod';

export const chatConfigSchema = z.object({
  enter_to_send: z.boolean().default(true),
  follow_up_enabled: z.boolean().default(false),
  /**
   * Default the Web TTS auto-play toggle to on. The actual playback is
   * additionally gated by global tts.enabled and the per-session
   * localStorage toggle managed by the Web client.
   */
  tts_autoplay: z.boolean().optional(),
});

export type ChatConfig = z.infer<typeof chatConfigSchema>;
