import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { normalizePath } from './utils/paths.ts';

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
  import.meta.url.includes('$bunfs') ||
  import.meta.url.includes('~BUN') ||
  import.meta.url.includes('%7EBUN');

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
  // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
  const envDir = process.env.PI_PACKAGE_DIR;
  if (envDir) {
    return normalizePath(envDir);
  }

  if (isBunBinary) {
    // Bun binary: process.execPath points to the compiled executable
    return dirname(process.execPath);
  }
  // Node.js: walk up from __dirname until we find package.json
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Fallback (shouldn't happen)
  return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
  if (isBunBinary) {
    return join(getPackageDir(), 'theme');
  }
  // Theme is in modes/interactive/theme/ relative to src/ or dist/
  const packageDir = getPackageDir();
  const srcOrDist = existsSync(join(packageDir, 'src')) ? 'src' : 'dist';
  return join(packageDir, srcOrDist, 'modes', 'interactive', 'theme');
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
  if (isBunBinary) {
    return join(getPackageDir(), 'export-html');
  }
  const packageDir = getPackageDir();
  const srcOrDist = existsSync(join(packageDir, 'src')) ? 'src' : 'dist';
  return join(packageDir, srcOrDist, 'core', 'export-html');
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
  return join(getPackageDir(), 'package.json');
}

/** Get path to README.md */
export function getReadmePath(): string {
  return resolve(join(getPackageDir(), 'README.md'));
}

/** Get path to docs directory */
export function getDocsPath(): string {
  return resolve(join(getPackageDir(), 'docs'));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
  return resolve(join(getPackageDir(), 'examples'));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
  if (isBunBinary) {
    return join(getPackageDir(), 'assets');
  }
  const packageDir = getPackageDir();
  const srcOrDist = existsSync(join(packageDir, 'src')) ? 'src' : 'dist';
  return join(packageDir, srcOrDist, 'modes', 'interactive', 'assets');
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
  return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
  name?: string;
  version?: string;
  piConfig?: {
    name?: string;
    configDir?: string;
  };
}

// Read package.json at runtime to avoid import attribute issues with Node.js 24+
import { readFileSync } from 'fs';

const packageJsonPath = join(getPackageDir(), 'package.json');
const packageJsonInline = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const pkg: PackageJson = packageJsonInline as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || '@agentboster-cli/core';
export const APP_NAME: string = piConfigName || 'pi';
export const APP_TITLE: string = piConfigName ? APP_NAME : 'π';
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || '.pi';
export const VERSION: string = pkg.version || '0.0.0';

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

export function expandTildePath(path: string): string {
  return normalizePath(path);
}

// =============================================================================
// User Config Paths (~/.config/agentboster-cli/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.config/agentboster-cli/agent/) */
export function getAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    return expandTildePath(envDir);
  }
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(
        home,
        'Library',
        'Application Support',
        'agentboster-cli',
        'agent',
      );
    case 'win32':
      return join(
        process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
        'agentboster-cli',
        'agent',
      );
    default:
      return join(home, '.config', 'agentboster-cli', 'agent');
  }
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
  return join(getAgentDir(), 'themes');
}

/** Get path to models.json */
export function getModelsPath(): string {
  return join(getAgentDir(), 'models.json');
}

/** Get path to auth.json */
export function getAuthPath(): string {
  return join(getAgentDir(), 'auth.json');
}

/** Get path to settings.json */
export function getSettingsPath(): string {
  return join(getAgentDir(), 'settings.json');
}

/** Get path to tools directory */
export function getToolsDir(): string {
  return join(getAgentDir(), 'tools');
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
  return join(getAgentDir(), 'bin');
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
  return join(getAgentDir(), 'prompts');
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
  return join(getAgentDir(), 'sessions');
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
  return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
