import { spawn } from 'node:child_process';

function isVercelProductionBuild() {
  return (
    process.env.VERCEL === '1' &&
    (process.env.VERCEL_ENV === 'production' ||
      process.env.VERCEL_TARGET_ENV === 'production')
  );
}

function runCommand(command: string, args: string[] = []) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`${command} ${args.join(' ')} exited with code ${code}`),
      );
    });
  });
}

async function main() {
  if (!isVercelProductionBuild()) {
    console.log('[postbuild] skipping database push outside Vercel production');
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('[postbuild] DATABASE_URL is required in production');
  }

  console.log('[postbuild] ensuring pgvector extension');
  await runCommand('npx', ['tsx', 'scripts/ensure-vector-extension.ts']);

  console.log('[postbuild] pushing Drizzle schema');
  await runCommand('npx', ['drizzle-kit', 'push', '--force']);

  console.log('[postbuild] migrating message versions to unified model');
  await runCommand('npx', ['tsx', 'scripts/migrate-message-versions.ts']);

  console.log(
    '[postbuild] backfilling user_vault_entries from legacy vault_entries',
  );
  await runCommand('npx', [
    'tsx',
    'scripts/migrate-vault-entries-to-user-scoped.ts',
  ]);

  console.log(
    '[postbuild] introducing user workspaces + backfilling workspace_id',
  );
  await runCommand('npx', ['tsx', 'scripts/migrate-workspaces.ts']);

  console.log('[postbuild] database schema is up to date');
}

main().catch((error) => {
  console.error('[postbuild] failed:', error);
  process.exit(1);
});
