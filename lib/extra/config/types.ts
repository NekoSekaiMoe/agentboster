import type { L2AuthorizationWindow } from '../auth/types';
import type { DBConfig } from '../db/types';
import type { SandboxType } from '../sandbox/types';

export interface LocalScorerConfig {
  baseUrl: string;
  model: string;
  timeout: number;
}

export interface RemoteScorerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
}

export type L1FailurePolicy = 'open' | 'closed';

export interface ScorerConfig {
  l1Scorer: LocalScorerConfig | RemoteScorerConfig;
  l1FailurePolicy?: L1FailurePolicy;
}

export interface AgentClawConfig {
  server: { host: string; port: number };
  security: {
    l0RulesPath: string;
    l1Scorer: LocalScorerConfig | RemoteScorerConfig;
    l1FailurePolicy?: L1FailurePolicy;
    l2Auth: { enabled: boolean; defaultWindow: L2AuthorizationWindow };
    l2CachePath?: string;
  };
  sandbox: {
    defaultType: SandboxType;
    docker?: { socketPath: string };
    chroot?: { basePath: string };
    tmpfs?: { maxSize: string };
  };
  agents: { maxParallel: number; defaultTimeout: number };
  channels: {
    feishu: Record<string, unknown>;
    telegram: Record<string, unknown>;
    discord: Record<string, unknown>;
    slack: Record<string, unknown>;
  };
  auth: { jwtSecret: string; tokenExpiration: number };
  db: DBConfig;
  memory: { provider: 'vercel-kv' | 'mongodb'; connectionString?: string };
  cron: { pollers: PollerConfig[] };
  daemon: { enabled: boolean; endpoints: DaemonConfig[] };
}

import type { DaemonConfig } from '../agent/daemon/types';
import type { PollerConfig } from '../cron/types';
export type { PollerConfig, DaemonConfig };

export const DEFAULT_AGENT_CLAW_CONFIG: AgentClawConfig = {
  server: {
    host: '0.0.0.0',
    port: 3001,
  },
  security: {
    l0RulesPath: './config/l0_rules.json',
    l1Scorer: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'hachimi',
      timeout: 30000,
    },
    l1FailurePolicy: 'open',
    l2Auth: {
      enabled: true,
      defaultWindow: 'once',
    },
    l2CachePath: '/tmp/agentd/l2_cache.json',
  },
  sandbox: {
    defaultType: 'tmpfs',
    docker: { socketPath: '/var/run/docker.sock' },
    chroot: { basePath: '/var/sandbox/chroot' },
    tmpfs: { maxSize: '512M' },
  },
  agents: {
    maxParallel: 4,
    defaultTimeout: 300000,
  },
  channels: {
    feishu: {},
    telegram: {},
    discord: {},
    slack: {},
  },
  auth: {
    jwtSecret: '',
    tokenExpiration: 60 * 60 * 24 * 7,
  },
  db: {
    type: 'vercel-postgres',
    connectionString: '',
  },
  memory: {
    provider: 'vercel-kv',
  },
  cron: {
    pollers: [],
  },
  daemon: {
    enabled: false,
    endpoints: [],
  },
};
