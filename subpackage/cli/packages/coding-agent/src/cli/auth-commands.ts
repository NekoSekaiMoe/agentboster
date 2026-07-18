/**
 * `agentboster-cli auth` subcommands for managing provider credentials.
 *
 * These commands replace Desktop's direct file access to auth.json,
 * providing a proper CLI interface for auth management.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

interface AuthEntry {
  type: 'oauth' | 'api_key';
  [key: string]: unknown;
}

interface AuthStatus {
  agent_dir: string;
  auth_file: string;
  auth_file_exists: boolean;
  configured_providers: Array<{
    provider: string;
    source: 'auth_file_oauth' | 'auth_file_api_key' | 'environment';
    kind: 'oauth' | 'api_key' | 'unknown';
  }>;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  huggingface: 'HF_TOKEN',
  'kimi-coding': 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
};

function getAgentDir(): string {
  const envOverride = process.env.PI_CODING_AGENT_DIR;
  if (envOverride) {
    const trimmed = envOverride.trim();
    if (trimmed === '~') {
      return homedir();
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      return path.join(homedir(), trimmed.slice(2));
    }
    return trimmed;
  }
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'agentboster-cli',
        'agent',
      );
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'agentboster-cli',
        'agent',
      );
    default:
      return path.join(home, '.config', 'agentboster-cli', 'agent');
  }
}

function getAuthFilePath(): string {
  return path.join(getAgentDir(), 'auth.json');
}

function readAuthFile(): Record<string, AuthEntry> {
  const authPath = getAuthFilePath();
  if (!fs.existsSync(authPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(authPath, 'utf-8');
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, AuthEntry>): void {
  const authPath = getAuthFilePath();
  const agentDir = path.dirname(authPath);

  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * `agentboster-cli auth status` - List configured providers in JSON format
 */
export async function handleAuthStatus(): Promise<void> {
  const agentDir = getAgentDir();
  const authFile = getAuthFilePath();
  const authFileExists = fs.existsSync(authFile);

  const configured: AuthStatus['configured_providers'] = [];

  // Read from auth.json
  if (authFileExists) {
    const authData = readAuthFile();
    for (const [provider, cred] of Object.entries(authData)) {
      const kind =
        cred.type === 'oauth'
          ? 'oauth'
          : cred.type === 'api_key'
            ? 'api_key'
            : 'unknown';
      const source = kind === 'oauth' ? 'auth_file_oauth' : 'auth_file_api_key';
      configured.push({ provider, source, kind });
    }
  }

  // Check environment variables
  for (const [provider, envKey] of Object.entries(PROVIDER_ENV_MAP)) {
    const envValue = process.env[envKey];
    if (envValue?.trim()) {
      // Skip if already listed from auth.json
      if (configured.some((p) => p.provider === provider)) {
        continue;
      }
      configured.push({
        provider,
        source: 'environment',
        kind: 'api_key',
      });
    }
  }

  configured.sort((a, b) => a.provider.localeCompare(b.provider));

  const status: AuthStatus = {
    agent_dir: agentDir,
    auth_file: authFile,
    auth_file_exists: authFileExists,
    configured_providers: configured,
  };

  console.log(JSON.stringify(status, null, 2));
}

/**
 * `agentboster-cli auth logout <provider>` - Remove provider credentials
 */
export async function handleAuthLogout(provider: string): Promise<void> {
  const normalized = provider.trim().toLowerCase();

  if (!normalized) {
    console.error('Error: Provider name cannot be empty');
    process.exit(1);
  }

  const authFile = getAuthFilePath();
  let removed = false;

  if (fs.existsSync(authFile)) {
    const authData = readAuthFile();
    if (authData[normalized]) {
      delete authData[normalized];
      writeAuthFile(authData);
      removed = true;
    }
  }

  const envKey = PROVIDER_ENV_MAP[normalized];
  const hasEnvVar = envKey && process.env[envKey]?.trim();

  const result = {
    provider: normalized,
    removed,
    source: removed ? 'auth_file' : hasEnvVar ? 'environment' : 'missing',
  };

  console.log(JSON.stringify(result, null, 2));

  if (removed) {
    process.exit(0);
  } else if (hasEnvVar) {
    console.error(
      `Note: ${normalized} is configured via environment variable ${envKey}`,
    );
    process.exit(1);
  } else {
    console.error(`Note: No credentials found for ${normalized}`);
    process.exit(1);
  }
}

/**
 * Dispatch `agentboster-cli auth <subcommand>` from argv.
 */
export async function handleAuthCommand(args: string[]): Promise<boolean> {
  if (args.length === 0 || args[0] !== 'auth') {
    return false;
  }

  const subcommand = args[1];

  if (!subcommand) {
    console.error('Usage: agentboster-cli auth <status|logout>');
    console.error('');
    console.error('Subcommands:');
    console.error('  status              List configured providers (JSON)');
    console.error('  logout <provider>   Remove provider credentials');
    process.exit(1);
  }

  if (subcommand === 'status') {
    await handleAuthStatus();
    return true;
  }

  if (subcommand === 'logout') {
    const provider = args[2];
    if (!provider) {
      console.error('Error: Missing provider name');
      console.error('Usage: agentboster-cli auth logout <provider>');
      process.exit(1);
    }
    await handleAuthLogout(provider);
    return true;
  }

  console.error(`Unknown auth subcommand: ${subcommand}`);
  console.error('Available: status, logout');
  process.exit(1);
}
