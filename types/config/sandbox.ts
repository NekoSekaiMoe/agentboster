import { z } from 'zod';

export const sandboxTypeEnum = z.enum(['tmpfs', 'docker', 'chroot']);

export type SandboxType = z.infer<typeof sandboxTypeEnum>;

export const sandboxConfigSchema = z.object({
  defaultType: sandboxTypeEnum.default('tmpfs'),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
