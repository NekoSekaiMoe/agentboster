interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface WelcomeDashboardInventory {
  skills: string[];
  extensions: string[];
  themes: string[];
  currentCliVersion: string | null;
  latestCliVersion: string | null;
  updateAvailable: boolean;
}

function joinFsPath(base: string, child: string): string {
  const separator = base.includes('\\') ? '\\' : '/';
  const normalizedBase = base.replace(/[\\/]+$/, '');
  return `${normalizedBase}${separator}${child}`;
}

/**
 * Resolve the agent data directory on the user's machine.
 *
 * Mirrors `getAgentDir()` in
 * `packages/coding-agent/src/config.ts` — the desktop package can't
 * import coding-agent directly (it's not part of the same workspace,
 * see subpackage/cli/AGENTS.md). Drift between these two copies
 * causes the welcome dashboard to read the wrong directory on
 * macOS/Windows (the previous hardcoded `~/.config/...` only worked
 * on Linux), leaving skills/extensions/themes invisible to the user.
 *
 * Rules (mirror config.ts, minus the env override which coding-agent
 * reads from `process.env` and is therefore not visible here in the
 * renderer — desktop users configure via the CLI binary, which in
 * turn reads its own env at runtime):
 *  - macOS:  ~/Library/Application Support/agentboster-cli/agent
 *  - Windows: %LOCALAPPDATA%/agentboster-cli/agent
 *  - Linux/other: ~/.config/agentboster-cli/agent
 */
async function resolveAgentDir(home: string): Promise<string> {
  // NOTE: `navigator.platform` is deprecated in the Web spec but
  // Chromium still ships it and Tauri's WebView inherits that. The
  // correct long-term fix is `@tauri-apps/plugin-os`'s `platform()`
  // (returns 'macos' | 'windows' | 'linux' | ...), but adding that
  // dependency reshapes packages/desktop's yarn.lock and is tracked
  // separately. The empty-string fallback ensures we degrade to the
  // Linux default rather than throwing if some future Chromium
  // build removes navigator.platform entirely.
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) {
    return joinFsPath(
      joinFsPath(joinFsPath(home, 'Library'), 'Application Support'),
      joinFsPath('agentboster-cli', 'agent'),
    );
  }
  if (platform.includes('win')) {
    // %LOCALAPPDATA% isn't visible in the renderer; Tauri exposes
    // local app data via @tauri-apps/api/path, but reading it costs
    // an async round-trip and the common case resolves identically
    // to the join below.
    const localApp = joinFsPath(home, 'AppData\\Local');
    return joinFsPath(joinFsPath(localApp, 'agentboster-cli'), 'agent');
  }
  return joinFsPath(
    joinFsPath(joinFsPath(home, '.config'), 'agentboster-cli'),
    'agent',
  );
}

async function readDirSafe(path: string): Promise<DirEntry[]> {
  try {
    const { exists, readDir } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(path))) return [];
    return await readDir(path);
  } catch {
    return [];
  }
}

async function collectSkillNames(skillsRoot: string): Promise<string[]> {
  const names = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [
    { path: skillsRoot, depth: 0 },
  ];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    if (next.depth > 5) continue;
    const entries = await readDirSafe(next.path);
    for (const entry of entries) {
      const fullPath = joinFsPath(next.path, entry.name);
      if (entry.isDirectory) {
        queue.push({ path: fullPath, depth: next.depth + 1 });
        continue;
      }
      if (entry.isFile && entry.name.toLowerCase() === 'skill.md') {
        const parts = next.path.replace(/\\/g, '/').split('/');
        names.add(parts[parts.length - 1] || next.path);
      }
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

async function collectExtensionNames(
  extensionsRoot: string,
): Promise<string[]> {
  const names = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [
    { path: extensionsRoot, depth: 0 },
  ];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    if (next.depth > 2) continue;
    const entries = await readDirSafe(next.path);
    for (const entry of entries) {
      const fullPath = joinFsPath(next.path, entry.name);
      if (entry.isDirectory) {
        if (next.depth > 0) names.add(entry.name);
        queue.push({ path: fullPath, depth: next.depth + 1 });
        continue;
      }
      if (entry.isFile && entry.name.toLowerCase().endsWith('.json')) {
        names.add(entry.name.replace(/\.json$/i, ''));
      }
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

async function collectThemeNames(themesRoot: string): Promise<string[]> {
  const entries = await readDirSafe(themesRoot);
  return entries
    .filter(
      (entry) => entry.isFile && entry.name.toLowerCase().endsWith('.json'),
    )
    .map((entry) => entry.name.replace(/\.json$/i, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function loadWelcomeDashboardInventory(): Promise<WelcomeDashboardInventory> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  const agentRoot = await resolveAgentDir(home);
  const skillsRoot = joinFsPath(agentRoot, 'skills');
  const extensionsRoot = joinFsPath(agentRoot, 'extensions');
  const themesRoot = joinFsPath(agentRoot, 'themes');

  const [skills, extensions, themes] = await Promise.all([
    collectSkillNames(skillsRoot),
    collectExtensionNames(extensionsRoot),
    collectThemeNames(themesRoot),
  ]);

  return {
    skills,
    extensions,
    themes,
    currentCliVersion: null,
    latestCliVersion: null,
    updateAvailable: false,
  };
}
