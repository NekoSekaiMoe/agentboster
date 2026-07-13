import { isProductionDeployment } from '@/lib/bot/webhook';
import { hasConfiguredPublicAppUrl, isVercel } from '@/lib/deploy';

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

  if (hasConfiguredPublicAppUrl()) {
    return {
      key: 'workflow',
      label: 'Workflow',
      status: 'ready',
      message: isVercel
        ? 'Workflow callbacks will use the Vercel production URL for webhook generation.'
        : 'Workflow callbacks will use PUBLIC_APP_URL for webhook generation.',
      requiredEnvVars: [],
      missingEnvVars: [],
    };
  }

  const requiredVar = isVercel
    ? 'NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL'
    : 'PUBLIC_APP_URL';

  return {
    key: 'workflow',
    label: 'Workflow',
    status: 'missing',
    message: isVercel
      ? 'Set NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL to your production Vercel domain so webhook callbacks can resolve the app base URL.'
      : 'Set PUBLIC_APP_URL to your public origin so webhook callbacks can resolve the app base URL.',
    requiredEnvVars: [requiredVar],
    missingEnvVars: [requiredVar],
  };
}

const SELF_HOST_BLOB_ENV_VARS = [
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];

function buildBlobCheck(): RuntimeDependencyHealth {
  if (isVercel) {
    if (hasEnv('BLOB_READ_WRITE_TOKEN')) {
      return {
        key: 'blob',
        label: 'Blob',
        status: 'ready',
        message:
          'Vercel Blob is configured. Set BLOB_ACCESS=private when the linked Vercel Blob store uses private access.',
        requiredEnvVars: ['BLOB_READ_WRITE_TOKEN'],
        missingEnvVars: [],
      };
    }

    return {
      key: 'blob',
      label: 'Blob',
      status: 'degraded',
      message:
        'Blob writes need BLOB_READ_WRITE_TOKEN. Attachment and skill import/export features may be unavailable until then.',
      requiredEnvVars: ['BLOB_READ_WRITE_TOKEN'],
      missingEnvVars: ['BLOB_READ_WRITE_TOKEN'],
    };
  }

  // Self-hosted: S3/MinIO-compatible object storage.
  const missingEnvVars = SELF_HOST_BLOB_ENV_VARS.filter(
    (name) => !hasEnv(name),
  );

  if (missingEnvVars.length === 0) {
    return {
      key: 'blob',
      label: 'Blob',
      status: 'ready',
      message:
        'S3/MinIO object storage is configured. Files are served through the /api/blob proxy route.',
      requiredEnvVars: SELF_HOST_BLOB_ENV_VARS,
      missingEnvVars: [],
    };
  }

  return {
    key: 'blob',
    label: 'Blob',
    status: 'degraded',
    message:
      'Self-hosted blob storage needs S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (plus S3_ENDPOINT for MinIO). Attachment and skill import/export features may be unavailable until then.',
    requiredEnvVars: SELF_HOST_BLOB_ENV_VARS,
    missingEnvVars,
  };
}

function buildSandboxCheck(input: {
  database: RuntimeDependencyHealth;
  kv: RuntimeDependencyHealth;
}): RuntimeDependencyHealth {
  const requiredEnvVars = isVercel
    ? ['DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']
    : ['DATABASE_URL'];
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
      requiredEnvVars,
      missingEnvVars: [],
    };
  }

  return {
    key: 'sandbox',
    label: 'Sandbox',
    status: 'missing',
    message:
      'Sandbox execution depends on both database-backed sessions and KV locks. Configure the missing DB/KV variables first.',
    requiredEnvVars,
    missingEnvVars,
  };
}

function buildKvCheck(
  database: RuntimeDependencyHealth,
): RuntimeDependencyHealth {
  if (!isVercel) {
    // Self-hosted KV is Postgres-backed (kv_store / kv_sets tables), so it
    // rides on DATABASE_URL rather than Upstash REST credentials.
    return {
      key: 'kv',
      label: 'KV',
      status: database.status === 'ready' ? 'ready' : 'missing',
      message:
        'Self-hosted KV is backed by Postgres (kv_store / kv_sets tables) and requires DATABASE_URL. Upstash REST credentials are not used.',
      requiredEnvVars: ['DATABASE_URL'],
      missingEnvVars: database.missingEnvVars,
    };
  }

  return buildRequiredEnvCheck({
    key: 'kv',
    label: 'KV',
    message:
      'KV is required for config storage, import jobs, chat state, and sandbox/session coordination.',
    requiredEnvVars: ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  });
}

export function getRuntimeHealthSnapshot(): RuntimeHealthSnapshot {
  const database = buildRequiredEnvCheck({
    key: 'database',
    label: 'Database',
    message:
      'Persistent sessions, summaries, and long-term memory storage require DATABASE_URL.',
    requiredEnvVars: ['DATABASE_URL'],
  });
  const kv = buildKvCheck(database);
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
