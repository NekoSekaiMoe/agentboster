import type { L2AuthorizationWindow } from '../auth/types';
import type { DBConfig } from '../db/types';
import type { SandboxType } from '../sandbox/types';
import type { PollerConfig } from '../cron/types';

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

export interface AgentBosterConfig {
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
    dockerStrict?: { cpuLimit: string; memoryLimit: string };
    lxc?: { rootfsBase: string; distro: string; release: string };
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
  memory: { provider: 'vercel-kv'; connectionString?: string };
  cron: { pollers: PollerConfig[] };
  daemon: { enabled: boolean; endpoints: DaemonConfig[] };
}

export type { PollerConfig };

export interface DaemonConfig {
  agentId: string;
  host: string;
  authType: 'jwt' | 'password';
  credentials: {
    webuiUsername: string;
    webuiPassword: string;
    systemUsername: string;
    systemPassword: string;
  };
}

export const DEFAULT_AGENT_BOSTER_CONFIG: AgentBosterConfig = {
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
    defaultType: 'docker',
    docker: { socketPath: '/var/run/docker.sock' },
    dockerStrict: { cpuLimit: '1', memoryLimit: '512M' },
    lxc: {
      rootfsBase: '/var/lib/agentd/lxc',
      distro: 'alpine',
      release: '3.21',
    },
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
