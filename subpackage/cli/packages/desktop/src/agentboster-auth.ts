export interface AgentbosterDesktopAuth {
  url: string;
  token: string;
  username?: string;
  configPath: string;
}

function joinFsPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export async function resolveAgentbosterConfigPath(): Promise<string | null> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = (await homeDir()).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!home) return null;
  return joinFsPath(home, '.config', 'agentboster-cli', 'config.json');
}

export async function readAgentbosterDesktopAuth(): Promise<AgentbosterDesktopAuth | null> {
  const configPath = await resolveAgentbosterConfigPath();
  if (!configPath) return null;

  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
  if (!(await exists(configPath))) return null;

  const raw = await readTextFile(configPath);
  const config = asRecord(JSON.parse(raw));
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  const token = typeof config.token === 'string' ? config.token.trim() : '';
  const username =
    typeof config.username === 'string' && config.username.trim().length > 0
      ? config.username.trim()
      : undefined;

  if (!url || !token) return null;

  return {
    url,
    token,
    username,
    configPath,
  };
}
