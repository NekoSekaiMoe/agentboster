import { getConfig } from '@/lib/core/kv/config';
import { resolveExtensions } from '@/lib/extra/extensions/manifest';

/**
 * GET /api/extensions
 *
 * Returns the catalog of registered third-party CLI extensions (claude-code,
 * codex, opencode, ...) after merging built-in defaults with user overrides
 * from AppConfig.extensions. Consumed by the Web UI to render the
 * "integrations" list — each row shows the extension's label, auth mode,
 * and a Probe button that hits /api/extensions/[name]/probe.
 *
 * No secrets are returned. authEnv is the list of env var NAMES the CLI
 * needs; values stay in the daemon's environment.
 */
export async function GET() {
  const config = await getConfig();
  const list = resolveExtensions(config.extensions);
  return Response.json({
    ok: true,
    extensions: list.map((ext) => ({
      name: ext.name,
      label: ext.label ?? ext.name,
      cliCommand: ext.cliCommand,
      defaultCliPath: ext.defaultCliPath,
      args: ext.args ?? [],
      authEnv: ext.authEnv ?? [],
      authMode: ext.authMode ?? 'env',
      description: ext.description,
    })),
  });
}
