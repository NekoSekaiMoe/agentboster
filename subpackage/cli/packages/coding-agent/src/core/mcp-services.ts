import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type McpServiceProtocol = 'mcp' | 'lsp';
export type McpServiceSource = 'builtin' | 'project-config';

export interface DiscoveredMcpService {
  id: string;
  name: string;
  protocol: McpServiceProtocol;
  description: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  source: McpServiceSource;
  sourcePath?: string;
  installed: boolean;
  executablePath: string | null;
  projectDetected: boolean;
  reason: string;
}

export interface RunningMcpService {
  id: string;
  name: string;
  protocol: McpServiceProtocol;
  command: string;
  args: string[];
  cwd: string;
  pid: number | null;
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
}

interface ServiceCandidate extends DiscoveredMcpService {
  env: Record<string, string>;
}

interface BuiltinServiceDefinition {
  id: string;
  name: string;
  protocol: McpServiceProtocol;
  description: string;
  command: string;
  args: string[];
  projectFiles: string[];
  projectGlobs: RegExp[];
}

export interface DiscoverMcpServicesOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StartMcpServiceOptions extends DiscoverMcpServicesOptions {
  onStderr?: (chunk: string) => void;
}

interface RunningEntry {
  child: ChildProcessWithoutNullStreams;
  status: RunningMcpService;
}

const BUILTIN_SERVICES: BuiltinServiceDefinition[] = [
  {
    id: 'clangd',
    name: 'clangd',
    protocol: 'lsp',
    description: 'C/C++ language service via clangd.',
    command: 'clangd',
    args: ['--background-index'],
    projectFiles: ['compile_commands.json', 'compile_flags.txt', '.clangd'],
    projectGlobs: [/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, /^CMakeLists\.txt$/],
  },
  {
    id: 'rust-analyzer',
    name: 'rust-analyzer',
    protocol: 'lsp',
    description: 'Rust language service via rust-analyzer.',
    command: 'rust-analyzer',
    args: [],
    projectFiles: ['Cargo.toml'],
    projectGlobs: [/\.rs$/i],
  },
  {
    id: 'gopls',
    name: 'gopls',
    protocol: 'lsp',
    description: 'Go language service via gopls.',
    command: 'gopls',
    args: [],
    projectFiles: ['go.mod', 'go.work'],
    projectGlobs: [/\.go$/i],
  },
  {
    id: 'typescript-language-server',
    name: 'typescript-language-server',
    protocol: 'lsp',
    description: 'TypeScript/JavaScript language service over stdio.',
    command: 'typescript-language-server',
    args: ['--stdio'],
    projectFiles: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    projectGlobs: [/\.(ts|tsx|js|jsx|mts|cts)$/i],
  },
  {
    id: 'pyright-langserver',
    name: 'pyright-langserver',
    protocol: 'lsp',
    description: 'Python language service via pyright-langserver.',
    command: 'pyright-langserver',
    args: ['--stdio'],
    projectFiles: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    projectGlobs: [/\.py$/i],
  },
];

function publicService(candidate: ServiceCandidate): DiscoveredMcpService {
  const { env: _env, ...service } = candidate;
  return service;
}

function normalizeCwd(cwd: string | undefined): string {
  return path.resolve(cwd ?? process.cwd());
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'service';
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      env[key] = rawValue;
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      env[key] = String(rawValue);
    }
  }
  return env;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(
      filePath,
      process.platform === 'win32'
        ? fsConstants.F_OK
        : fsConstants.X_OK | fsConstants.F_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function commandHasPath(command: string): boolean {
  return (
    command.includes('/') || command.includes('\\') || path.isAbsolute(command)
  );
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

const WELL_KNOWN_LSP_DIRS: string[] = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  return [
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share', 'nvim', 'mason', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.ghcup', 'bin'),
    path.join(home, '.elan', 'bin'),
    path.join(home, '.juliaup', 'bin'),
    ...(process.env.GOPATH ? [path.join(process.env.GOPATH, 'bin')] : []),
    ...(process.env.CARGO_HOME
      ? [path.join(process.env.CARGO_HOME, 'bin')]
      : []),
  ];
})();

async function findExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  if (commandHasPath(trimmed)) {
    const resolved = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(cwd, trimmed);
    candidates.push(resolved);
    if (process.platform === 'win32' && !path.extname(resolved)) {
      for (const ext of windowsPathExts(env)) {
        candidates.push(`${resolved}${ext}`);
      }
    }
  } else {
    const pathParts = (env.PATH || '')
      .split(path.delimiter)
      .filter((part) => part.length > 0);
    const names =
      process.platform === 'win32' && !path.extname(trimmed)
        ? windowsPathExts(env).map((ext) => `${trimmed}${ext}`)
        : [trimmed];
    for (const dir of pathParts) {
      for (const name of names) {
        candidates.push(path.join(dir, name));
      }
    }
    for (const dir of WELL_KNOWN_LSP_DIRS) {
      for (const name of names) {
        candidates.push(path.join(dir, name));
      }
    }
    const localNodeBin = path.join(cwd, 'node_modules', '.bin');
    for (const name of names) {
      candidates.push(path.join(localNodeBin, name));
    }
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function directoryHasMatchingFile(
  cwd: string,
  globs: RegExp[],
): Promise<boolean> {
  if (globs.length === 0) return false;
  let entries: string[];
  try {
    entries = await fs.readdir(cwd);
  } catch {
    return false;
  }
  return entries.some((entry) => globs.some((regex) => regex.test(entry)));
}

async function detectProject(
  cwd: string,
  definition: BuiltinServiceDefinition,
): Promise<{ detected: boolean; reason: string }> {
  for (const file of definition.projectFiles) {
    if (await pathExists(path.join(cwd, file))) {
      return { detected: true, reason: `found ${file}` };
    }
  }
  if (await directoryHasMatchingFile(cwd, definition.projectGlobs)) {
    return { detected: true, reason: 'matched source files in project root' };
  }
  return { detected: false, reason: 'available as a known service' };
}

async function discoverBuiltinServices(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ServiceCandidate[]> {
  const services: ServiceCandidate[] = [];
  for (const definition of BUILTIN_SERVICES) {
    const executablePath = await findExecutable(definition.command, cwd, env);
    const detected = await detectProject(cwd, definition);
    services.push({
      id: definition.id,
      name: definition.name,
      protocol: definition.protocol,
      description: definition.description,
      command: definition.command,
      args: [...definition.args],
      cwd,
      env: {},
      envKeys: [],
      source: 'builtin',
      installed: executablePath !== null,
      executablePath,
      projectDetected: detected.detected,
      reason: detected.reason,
    });
  }
  return services;
}

async function ancestorPaths(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  let current = cwd;
  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

function pickServerMap(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const direct = root.mcpServers ?? root.servers;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const nested = root.mcp;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedServers = (nested as Record<string, unknown>).servers;
    if (
      nestedServers &&
      typeof nestedServers === 'object' &&
      !Array.isArray(nestedServers)
    ) {
      return nestedServers as Record<string, unknown>;
    }
  }
  const agentboster = root.agentboster;
  if (
    agentboster &&
    typeof agentboster === 'object' &&
    !Array.isArray(agentboster)
  ) {
    const agentbosterServers = (agentboster as Record<string, unknown>)
      .mcpServers;
    if (
      agentbosterServers &&
      typeof agentbosterServers === 'object' &&
      !Array.isArray(agentbosterServers)
    ) {
      return agentbosterServers as Record<string, unknown>;
    }
  }
  return null;
}

const KNOWN_LSP_IDENTIFIERS = [
  'clangd',
  'gopls',
  'rust-analyzer',
  'language-server',
  'langserver',
  'pyright',
  'pylsp',
  'ruff-lsp',
  'jdtls',
  'solargraph',
  'ruby-lsp',
  'sorbet',
  'intelephense',
  'phpactor',
  'lua-language-server',
  'zls',
  'elixir-ls',
  'next-ls',
  'lexical',
  'dart',
  'metals',
  'omnisharp',
  'csharp-ls',
  'sourcekit-lsp',
  'haskell-language-server',
  'ocamllsp',
  'erlang-ls',
  'vhdl-ls',
  'texlab',
  'marksman',
  'taplo',
  'yaml-language-server',
  'vscode-json-language',
  'bash-language-server',
  'sqls',
  'nil',
  'nixd',
  'serve-d',
  'deno',
  'biome',
  'eslint',
];

function inferProtocol(
  name: string,
  command: string,
  rawProtocol: unknown,
): McpServiceProtocol {
  if (rawProtocol === 'lsp' || rawProtocol === 'mcp') return rawProtocol;
  const normalized = `${name} ${command}`.toLowerCase();
  for (const id of KNOWN_LSP_IDENTIFIERS) {
    if (normalized.includes(id)) return 'lsp';
  }
  return 'mcp';
}

async function parseProjectConfigFile(
  filePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ServiceCandidate[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return [];
  }

  const serverMap = pickServerMap(parsed);
  if (!serverMap) return [];

  const services: ServiceCandidate[] = [];
  for (const [name, rawServer] of Object.entries(serverMap)) {
    if (
      !rawServer ||
      typeof rawServer !== 'object' ||
      Array.isArray(rawServer)
    ) {
      continue;
    }
    const server = rawServer as Record<string, unknown>;
    const command =
      typeof server.command === 'string' ? server.command.trim() : '';
    if (!command) continue;

    const configDir = path.dirname(filePath);
    const serverCwd =
      typeof server.cwd === 'string' && server.cwd.trim()
        ? path.resolve(configDir, server.cwd.trim())
        : cwd;
    const serviceEnv = parseEnv(server.env);
    const executablePath = await findExecutable(command, serverCwd, {
      ...env,
      ...serviceEnv,
    });
    services.push({
      id: `config:${slugify(name)}`,
      name,
      protocol: inferProtocol(name, command, server.protocol),
      description:
        typeof server.description === 'string'
          ? server.description
          : `Project configured service from ${path.basename(filePath)}.`,
      command,
      args: parseStringArray(server.args),
      cwd: serverCwd,
      env: serviceEnv,
      envKeys: Object.keys(serviceEnv).sort(),
      source: 'project-config',
      sourcePath: filePath,
      installed: executablePath !== null,
      executablePath,
      projectDetected: true,
      reason: `configured in ${path.relative(cwd, filePath) || filePath}`,
    });
  }
  return services;
}

async function discoverProjectConfigServices(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ServiceCandidate[]> {
  const services: ServiceCandidate[] = [];
  const seenConfigPaths = new Set<string>();
  for (const dir of await ancestorPaths(cwd)) {
    for (const relative of [
      '.mcp.json',
      path.join('.cursor', 'mcp.json'),
      path.join('.vscode', 'mcp.json'),
      'package.json',
    ]) {
      const configPath = path.join(dir, relative);
      if (seenConfigPaths.has(configPath)) continue;
      seenConfigPaths.add(configPath);
      if (!(await pathExists(configPath))) continue;
      services.push(...(await parseProjectConfigFile(configPath, cwd, env)));
    }
  }
  return services;
}

function sortServices(
  a: DiscoveredMcpService,
  b: DiscoveredMcpService,
): number {
  if (a.projectDetected !== b.projectDetected) {
    return a.projectDetected ? -1 : 1;
  }
  if (a.installed !== b.installed) {
    return a.installed ? -1 : 1;
  }
  if (a.source !== b.source) {
    return a.source === 'project-config' ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

async function discoverMcpServiceCandidates(
  options: DiscoverMcpServicesOptions = {},
): Promise<ServiceCandidate[]> {
  const cwd = normalizeCwd(options.cwd);
  const env = options.env ?? process.env;
  const [configServices, builtinServices] = await Promise.all([
    discoverProjectConfigServices(cwd, env),
    discoverBuiltinServices(cwd, env),
  ]);
  return [...configServices, ...builtinServices].sort(sortServices);
}

export async function discoverMcpServices(
  options: DiscoverMcpServicesOptions = {},
): Promise<DiscoveredMcpService[]> {
  const candidates = await discoverMcpServiceCandidates(options);
  return candidates.map(publicService);
}

function resolveTarget(
  candidates: ServiceCandidate[],
  target: string,
): ServiceCandidate | null {
  const normalized = target.trim().toLowerCase();
  return (
    candidates.find((service) => service.id.toLowerCase() === normalized) ??
    candidates.find((service) => service.name.toLowerCase() === normalized) ??
    null
  );
}

function trimTail(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

export class McpServiceManager {
  private readonly running = new Map<string, RunningEntry>();

  async discover(
    options: DiscoverMcpServicesOptions = {},
  ): Promise<DiscoveredMcpService[]> {
    return discoverMcpServices(options);
  }

  listRunning(): RunningMcpService[] {
    return [...this.running.values()].map((entry) => ({ ...entry.status }));
  }

  async start(
    target: string,
    options: StartMcpServiceOptions = {},
  ): Promise<RunningMcpService> {
    const candidates = await discoverMcpServiceCandidates(options);
    const service = resolveTarget(candidates, target);
    if (!service) {
      throw new Error(`Unknown MCP service: ${target}`);
    }
    if (!service.installed) {
      throw new Error(
        `Cannot start ${service.name}: command "${service.command}" was not found on PATH.`,
      );
    }

    const existing = this.running.get(service.id);
    if (existing?.status.running) {
      return { ...existing.status };
    }

    const child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: { ...process.env, ...options.env, ...service.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', () => {});

    const status: RunningMcpService = {
      id: service.id,
      name: service.name,
      protocol: service.protocol,
      command: service.command,
      args: [...service.args],
      cwd: service.cwd,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      running: true,
      exitCode: null,
      signal: null,
      stderrTail: '',
    };
    const entry: RunningEntry = { child, status };
    this.running.set(service.id, entry);

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      status.stderrTail = trimTail(`${status.stderrTail}${text}`);
      options.onStderr?.(text);
    });

    child.once('exit', (code, signal) => {
      status.running = false;
      status.exitCode = code;
      status.signal = signal;
      this.running.delete(service.id);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onError = (err: Error) => {
        status.running = false;
        this.running.delete(service.id);
        finish(err);
      };
      const timer = setTimeout(() => finish(), 150);
      child.once('error', onError);
      child.once('spawn', () => finish());
    });

    return { ...status };
  }

  async stop(target: string): Promise<RunningMcpService | null> {
    const normalized = target.trim().toLowerCase();
    const entry =
      this.running.get(target) ??
      [...this.running.values()].find(
        (item) =>
          item.status.id.toLowerCase() === normalized ||
          item.status.name.toLowerCase() === normalized,
      ) ??
      null;
    if (!entry) return null;

    entry.status.running = false;
    entry.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.child.kill('SIGKILL');
        resolve();
      }, 1000);
      entry.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.running.delete(entry.status.id);
    return { ...entry.status };
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.listRunning().map((item) => this.stop(item.id)));
  }

  async waitForExit(target: string): Promise<RunningMcpService | null> {
    const normalized = target.trim().toLowerCase();
    const entry =
      this.running.get(target) ??
      [...this.running.values()].find(
        (item) =>
          item.status.id.toLowerCase() === normalized ||
          item.status.name.toLowerCase() === normalized,
      ) ??
      null;
    if (!entry) return null;
    await new Promise<void>((resolve) => {
      entry.child.once('exit', () => resolve());
    });
    return { ...entry.status };
  }
}
