import { z } from 'zod';

const agentdSandboxTypeEnum = z.enum(['docker', 'docker-strict', 'lxc']);

export const sandboxTypeEnum = z.preprocess((value) => {
  // Compatibility only: older Web configs may still store tmpfs/chroot.
  // New sandbox logic uses docker/docker-strict/lxc.
  if (value === 'tmpfs') return 'docker';
  if (value === 'chroot') return 'lxc';
  return value;
}, agentdSandboxTypeEnum);

export type SandboxType = z.infer<typeof sandboxTypeEnum>;

export const sandboxConfigSchema = z.object({
  defaultType: sandboxTypeEnum.default('docker'),
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
