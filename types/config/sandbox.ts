import { z } from 'zod';

export const sandboxTypeEnum = z.enum(['tmpfs', 'docker', 'chroot']);

export type SandboxType = z.infer<typeof sandboxTypeEnum>;

export const sandboxConfigSchema = z.object({
  defaultType: sandboxTypeEnum.default('tmpfs'),
  workspace: z
    .object({
      skillsDir: z.string().default('/workspace/skills'),
      downloadsDir: z.string().default('/workspace/downloads'),
      sessionsDir: z.string().default('/workspace/sessions'),
      memoryDir: z.string().default('/workspace/memory'),
      outputsDir: z.string().default('/workspace/outputs'),
      mediaRetentionDays: z.number().int().min(1).default(3),
    })
    .default(() => ({
      skillsDir: '/workspace/skills',
      downloadsDir: '/workspace/downloads',
      sessionsDir: '/workspace/sessions',
      memoryDir: '/workspace/memory',
      outputsDir: '/workspace/outputs',
      mediaRetentionDays: 3,
    })),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
