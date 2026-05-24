import { z } from 'zod';

const localScorerConfigSchema = z.object({
  baseUrl: z.string().default('http://localhost:11434/v1'),
  model: z.string().default('hachimi'),
  timeout: z.number().default(30000),
});

const remoteScorerConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  timeout: z.number().default(30000),
});

const l2AuthorizationWindowSchema = z.enum([
  'once',
  '10min',
  '1hour',
  '1day',
  'session',
]);

const sandboxTypeSchema = z.enum(['tmpfs', 'docker', 'chroot']);

const dbProviderTypeSchema = z.enum(['vercel-postgres', 'mongodb']);

const defaultLocalScorer = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'hachimi',
  timeout: 30000,
};

export const agentClawConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().default(3001),
  }),

  security: z.object({
    l0RulesPath: z.string().default('./config/l0_rules.json'),
    l1Scorer: z
      .union([localScorerConfigSchema, remoteScorerConfigSchema])
      .default(defaultLocalScorer),
    l2Auth: z.object({
      enabled: z.boolean().default(true),
      defaultWindow: l2AuthorizationWindowSchema.default('once'),
    }),
  }),

  sandbox: z.object({
    defaultType: sandboxTypeSchema.default('tmpfs'),
    docker: z
      .object({
        socketPath: z.string().default('/var/run/docker.sock'),
      })
      .optional(),
    chroot: z
      .object({
        basePath: z.string().default('/var/sandbox/chroot'),
      })
      .optional(),
    tmpfs: z
      .object({
        maxSize: z.string().default('512M'),
      })
      .optional(),
  }),

  agents: z.object({
    maxParallel: z.number().default(4),
    defaultTimeout: z.number().default(300000),
  }),

  channels: z.object({
    feishu: z.record(z.string(), z.unknown()).default({}),
    telegram: z.record(z.string(), z.unknown()).default({}),
    discord: z.record(z.string(), z.unknown()).default({}),
    slack: z.record(z.string(), z.unknown()).default({}),
  }),

  auth: z.object({
    jwtSecret: z.string().default(''),
    tokenExpiration: z.number().default(60 * 60 * 24 * 7),
  }),

  db: z.object({
    type: dbProviderTypeSchema.default('vercel-postgres'),
    connectionString: z.string().default(''),
    ssl: z.boolean().default(false),
  }),

  memory: z.object({
    provider: z.enum(['vercel-kv', 'mongodb']).default('vercel-kv'),
    connectionString: z.string().optional(),
  }),

  cron: z.object({
    pollers: z
      .array(
        z.object({
          interval: z.number(),
          taskType: z.string(),
          handler: z.string(),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
  }),

  daemon: z.object({
    enabled: z.boolean().default(false),
    endpoints: z
      .array(
        z.object({
          agentId: z.string(),
          host: z.string(),
          authType: z.enum(['jwt', 'password']),
          credentials: z.object({
            webuiUsername: z.string(),
            webuiPassword: z.string(),
            systemUsername: z.string(),
            systemPassword: z.string(),
          }),
        }),
      )
      .default([]),
  }),
});

export type AgentClawConfig = z.infer<typeof agentClawConfigSchema>;

export function parseAgentClawConfig(input: unknown): AgentClawConfig {
  return agentClawConfigSchema.parse(input);
}
