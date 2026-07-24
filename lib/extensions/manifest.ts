/**
 * Third-party CLI extension manifest (Team Mode ecosystem — AionHub §1-3).
 *
 * Borrowed from AionHub's `aion-extension.json` format
 * (the extensions/aionext-STAR/ directories). AionHub declares each
 * third-party CLI agent (claude code, codex, opencode, ...) as a manifest
 * with `cliCommand`, `defaultCliPath`, `acpArgs`, and lifecycle hooks, then
 * a shared ACP adapter spawns and talks to them.
 *
 * AgentBoster's port is intentionally narrower than AionHub's full ACP
 * bidirectional protocol: we only declare enough to SPAWN the CLI as a
 * subprocess (via the hardened CommandBuilder from batch #2), surface its
 * JSON-stream output (batch #10's contract), and feed it the auth material
 * it needs. A full ACP handshake (initialize / capabilities / authMethods
 * dynamic rendering) is left as future work — this batch ships the manifest
 * format + loader + a probe tool, enough to register a CLI and verify it's
 * callable.
 *
 * Manifest shape (stored under AppConfig.extensions):
 *
 *   {
 *     "name": "claude-code",
 *     "cliCommand": "claude",
 *     "defaultCliPath": "bunx @agentclientprotocol/claude-agent-acp",
 *     "args": [],
 *     "authEnv": ["ANTHROPIC_API_KEY"],
 *     "authMode": "env",                    // 'env' | 'oauth' | 'terminal'
 *     "description": "Anthropic Claude Code (ACP)"
 *   }
 */

export type ExtensionAuthMode = 'env' | 'oauth' | 'terminal';

export interface CliExtensionManifest {
  /** Stable unique id, e.g. "claude-code". */
  name: string;
  /** Display label for the UI. */
  label?: string;
  /** The binary name to exec (resolved on PATH). */
  cliCommand: string;
  /**
   * Default invocation when the bare command isn't on PATH — e.g.
   * `bunx @agentclientprotocol/claude-agent-acp` for claude code. The loader
   * tries `cliCommand` first, then falls back to this.
   */
  defaultCliPath?: string;
  /** Extra argv passed after the command. */
  args?: string[];
  /**
   * Env var names the CLI needs to authenticate (e.g. ANTHROPIC_API_KEY).
   * The probe/spawn step checks these are set in the process env before
   * invoking — missing ones produce a clear error rather than a silent
   * child crash. The VALUES are never stored in the manifest; the user
   * sets them in the daemon's environment.
   */
  authEnv?: string[];
  /** How the CLI expects to receive credentials. */
  authMode?: ExtensionAuthMode;
  /** Human-readable description shown in the UI. */
  description?: string;
  /**
   * Optional shell command to run once on register (AionHub onInstall).
   * Used to prefetch dependencies (e.g. `bun install` for a bunx adapter).
   */
  onInstall?: {
    command: string;
    args?: string[];
    timeoutMs?: number;
  };
}

/**
 * Built-in manifests for the most common third-party coding agents. Users
 * can override or extend via AppConfig.extensions. Each entry is deliberately
 * conservative — `defaultCliPath` is only set when the bare command typically
 * isn't installed, and authEnv lists the canonical env var.
 */
export const BUILTIN_EXTENSIONS: CliExtensionManifest[] = [
  {
    name: 'claude-code',
    label: 'Claude Code',
    cliCommand: 'claude',
    defaultCliPath: 'bunx @agentclientprotocol/claude-agent-acp',
    args: [],
    authEnv: ['ANTHROPIC_API_KEY'],
    authMode: 'env',
    description: 'Anthropic Claude Code (ACP adapter)',
  },
  {
    name: 'codex',
    label: 'OpenAI Codex',
    cliCommand: 'codex',
    authEnv: ['OPENAI_API_KEY'],
    authMode: 'env',
    description: 'OpenAI Codex CLI',
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    cliCommand: 'opencode',
    defaultCliPath: 'bunx opencode-ai',
    authEnv: ['OPENAI_API_KEY'],
    authMode: 'env',
    description: 'OpenCode CLI',
  },
];

/**
 * Resolve the effective list of extensions: built-ins overlaid with user
 * config (user entries with the same `name` replace the built-in). User
 * entries with a new `name` are appended.
 */
export function resolveExtensions(
  userExtensions?: CliExtensionManifest[],
): CliExtensionManifest[] {
  if (!userExtensions || userExtensions.length === 0) {
    return BUILTIN_EXTENSIONS;
  }
  const byName = new Map<string, CliExtensionManifest>();
  for (const ext of BUILTIN_EXTENSIONS) byName.set(ext.name, ext);
  for (const ext of userExtensions) byName.set(ext.name, ext);
  return [...byName.values()];
}

/**
 * Pick the invocation command for an extension: `cliCommand` if it's likely
 * on PATH, otherwise `defaultCliPath` (split into command + args for the
 * subprocess builder). Returns null when neither is usable.
 */
export function resolveInvocation(
  ext: CliExtensionManifest,
): { command: string; args: string[] } | null {
  // Prefer the bare cliCommand — if the user installed it directly it's the
  // cheapest path. defaultCliPath is the fallback for `bunx ...` / `npx ...`
  // style adapters that don't put a binary on PATH.
  if (ext.cliCommand) {
    return { command: ext.cliCommand, args: ext.args ?? [] };
  }
  if (ext.defaultCliPath) {
    const parts = ext.defaultCliPath.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    return {
      command: parts[0]!,
      args: [...parts.slice(1), ...(ext.args ?? [])],
    };
  }
  return null;
}

/**
 * Check that every env var the extension declares under authEnv is present
 * in the given env snapshot. Returns the list of MISSING names (empty =
 * ready to spawn). The daemon calls this before invoking the CLI so a
 * misconfigured extension fails with a clear message instead of a opaque
 * child-process crash.
 */
export function missingAuthEnv(
  ext: CliExtensionManifest,
  env: Record<string, string | undefined>,
): string[] {
  return (ext.authEnv ?? []).filter((name) => !env[name]);
}
