import { isProductionDeployment } from '@/lib/bot/webhook';

export type RuntimeDependencyKey =
  | 'database'
  | 'kv'
  | 'blob'
  | 'workflow'
  | 'sandbox';

export type RuntimeDependencyStatus = 'ready' | 'degraded' | 'missing';

export type RuntimeDependencyHealth = {
  key: RuntimeDependencyKey;
  label: string;
  status: RuntimeDependencyStatus;
  message: string;
  requiredEnvVars: string[];
  missingEnvVars: string[];
};

export type RuntimeHealthSnapshot = {
  status: 'ready' | 'degraded';
  checks: RuntimeDependencyHealth[];
  updatedAt: string;
};

function hasEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function buildRequiredEnvCheck(input: {
  key: RuntimeDependencyKey;
  label: string;
  message: string;
  requiredEnvVars: string[];
}): RuntimeDependencyHealth {
  const missingEnvVars = input.requiredEnvVars.filter((name) => !hasEnv(name));

  return {
    key: input.key,
    label: input.label,
    status: missingEnvVars.length === 0 ? 'ready' : 'missing',
    message: input.message,
    requiredEnvVars: input.requiredEnvVars,
    missingEnvVars,
  };
}

function buildWorkflowCheck(): RuntimeDependencyHealth {
  if (!isProductionDeployment()) {
    return {
      key: 'workflow',
      label: 'Workflow',
      status: 'ready',
      message:
        'Workflow callbacks can use the local base URL during development.',
      requiredEnvVars: [],
      missingEnvVars: [],
    };
  }

  const vercelUrl =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL?.trim();

  if (vercelUrl) {
    return {
      key: 'workflow',
      label: 'Workflow',
      status: 'ready',
      message:
        'Workflow callbacks will use the Vercel production URL for webhook generation.',
      requiredEnvVars: [],
      missingEnvVars: [],
    };
  }

  return {
    key: 'workflow',
    label: 'Workflow',
    status: 'missing',
    message:
      'Set NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL to your production Vercel domain so webhook callbacks can resolve the app base URL.',
    requiredEnvVars: ['NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL'],
    missingEnvVars: ['NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL'],
  };
}

function buildBlobCheck(): RuntimeDependencyHealth {
  if (hasEnv('BLOB_READ_WRITE_TOKEN')) {
    return {
      key: 'blob',
      label: 'Blob',
      status: 'ready',
      message:
        'Blob storage is configured. Set BLOB_ACCESS=private when the linked Vercel Blob store uses private access.',
      requiredEnvVars: ['BLOB_READ_WRITE_TOKEN'],
      missingEnvVars: [],
    };
  }

  return {
    key: 'blob',
    label: 'Blob',
    status: 'degraded',
    message:
      'Blob writes need BLOB_READ_WRITE_TOKEN in local/dev, or a linked Blob store in Vercel. Attachment and skill import/export features may be unavailable until then.',
    requiredEnvVars: ['BLOB_READ_WRITE_TOKEN'],
    missingEnvVars: ['BLOB_READ_WRITE_TOKEN'],
  };
}

function buildSandboxCheck(input: {
  database: RuntimeDependencyHealth;
  kv: RuntimeDependencyHealth;
}): RuntimeDependencyHealth {
  const missingEnvVars = [
    ...input.database.missingEnvVars,
    ...input.kv.missingEnvVars,
  ];

  if (missingEnvVars.length === 0) {
    return {
      key: 'sandbox',
      label: 'Sandbox',
      status: 'ready',
      message:
        'Sandbox runtime prerequisites are present. Session sandbox state can use DB-backed sessions and KV locking.',
      requiredEnvVars: ['DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'],
      missingEnvVars: [],
    };
  }

  return {
    key: 'sandbox',
    label: 'Sandbox',
    status: 'missing',
    message:
      'Sandbox execution depends on both database-backed sessions and KV locks. Configure the missing DB/KV variables first.',
    requiredEnvVars: ['DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    missingEnvVars,
  };
}

export function getRuntimeHealthSnapshot(): RuntimeHealthSnapshot {
  const database = buildRequiredEnvCheck({
    key: 'database',
    label: 'Database',
    message:
      'Persistent sessions, summaries, and long-term memory storage require DATABASE_URL.',
    requiredEnvVars: ['DATABASE_URL'],
  });
  const kv = buildRequiredEnvCheck({
    key: 'kv',
    label: 'KV',
    message:
      'KV is required for config storage, import jobs, chat state, and sandbox/session coordination.',
    requiredEnvVars: ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  });
  const blob = buildBlobCheck();
  const workflow = buildWorkflowCheck();
  const sandbox = buildSandboxCheck({ database, kv });

  const checks = [database, kv, blob, workflow, sandbox];

  return {
    status: checks.every((check) => check.status === 'ready')
      ? 'ready'
      : 'degraded',
    checks,
    updatedAt: new Date().toISOString(),
  };
}
