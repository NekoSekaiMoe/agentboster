/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { createInterface as createInterfacePromises } from 'node:readline/promises';
import { type ImageContent, modelsAreEqual } from '@agentboster-cli/ai';
import {
  createAgentbosterStreamFn,
  evaluateLocalCommand,
  fetchRemoteModels,
  fetchUserPreferences,
  formatToolRequest,
  getStoredAuth,
  remoteModelsToPiModels,
} from '@agentboster/adapter';
import type { StreamFn } from '@agentboster-cli/agent';
import chalk from 'chalk';
import {
  fetchRemoteMessages,
  listRemoteSessions,
  patchRemoteSession,
  type RemoteSession,
} from './core/remote-sessions.ts';
import { type Args, type Mode, parseArgs, printHelp } from './cli/args.ts';
import { processFileArguments } from './cli/file-processor.ts';
import { buildInitialMessage } from './cli/initial-message.ts';
import { listModels } from './cli/list-models.ts';
import { createProjectTrustContext } from './cli/project-trust.ts';
import {
  shouldRunFirstTimeSetup,
  showFirstTimeSetup,
  showStartupSelector,
} from './cli/startup-ui.ts';
import { getAgentDir, VERSION } from './config.ts';
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionRuntime,
} from './core/agent-session-runtime.ts';
import {
  type AgentSessionRuntimeDiagnostic,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from './core/agent-session-services.ts';
import { formatNoModelsAvailableMessage } from './core/auth-guidance.ts';
import { AuthStorage } from './core/auth-storage.ts';
import { exportFromFile } from './core/export-html/index.ts';
import type { ExtensionFactory } from './core/extensions/types.ts';
import {
  applyHttpProxySettings,
  configureHttpDispatcher,
} from './core/http-dispatcher.ts';
import type { ModelRegistry } from './core/model-registry.ts';
import {
  resolveCliModel,
  resolveModelScope,
  type ScopedModel,
} from './core/model-resolver.ts';
import { restoreStdout, takeOverStdout } from './core/output-guard.ts';
import { type AppMode, resolveProjectTrusted } from './core/project-trust.ts';
import type { CreateAgentSessionOptions } from './core/sdk.ts';
import { getRemoteExecTarget } from './core/remote-exec.ts';
import {
  formatMissingSessionCwdPrompt,
  getMissingSessionCwdIssue,
  MissingSessionCwdError,
  type SessionCwdIssue,
} from './core/session-cwd.ts';
import {
  assertValidSessionId,
  cleanStaleTempSessions,
  SessionManager,
} from './core/session-manager.ts';
import { SettingsManager } from './core/settings-manager.ts';
import { printTimings, resetTimings, time } from './core/timings.ts';
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from './core/trust-manager.ts';
import { runMigrations, showDeprecationWarnings } from './migrations.ts';
import { InteractiveMode, runPrintMode, runRpcMode } from './modes/index.ts';
import {
  initTheme,
  stopThemeWatcher,
} from './modes/interactive/theme/theme.ts';
import {
  handleConfigCommand,
  handlePackageCommand,
} from './package-manager-cli.ts';
import { handleLoginCommand } from './cli/login.ts';
import { handleAuthCommand } from './cli/auth-commands.ts';
import { handleMcpCommand } from './cli/mcp-commands.ts';
import { handleRemoteCommand } from './cli/remote-control-commands.ts';
import { isLocalPath, resolvePath } from './utils/paths.ts';

const EXTENSION_LOAD_FAILURE_HINT =
  'Hint: Start without extensions using "pi -ne".';

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
  // If stdin is a TTY, we're running interactively - don't read stdin
  if (process.stdin.isTTY) {
    return undefined;
  }

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim() || undefined);
    });
    process.stdin.resume();
  });
}

function collectSettingsDiagnostics(
  settingsManager: SettingsManager,
  context: string,
): AgentSessionRuntimeDiagnostic[] {
  return settingsManager.drainErrors().map(({ scope, error }) => ({
    type: 'warning',
    message: `(${context}, ${scope} settings) ${error.message}`,
  }));
}

function reportDiagnostics(
  diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    const color =
      diagnostic.type === 'error'
        ? chalk.red
        : diagnostic.type === 'warning'
          ? chalk.yellow
          : chalk.dim;
    const prefix =
      diagnostic.type === 'error'
        ? 'Error: '
        : diagnostic.type === 'warning'
          ? 'Warning: '
          : '';
    console.error(color(`${prefix}${diagnostic.message}`));
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value === '1' ||
    value.toLowerCase() === 'true' ||
    value.toLowerCase() === 'yes'
  );
}

function resolveAppMode(
  parsed: Args,
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): AppMode {
  if (parsed.mode === 'rpc') {
    return 'rpc';
  }
  if (parsed.mode === 'json') {
    return 'json';
  }
  if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
    return 'print';
  }
  return 'interactive';
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, 'rpc'> {
  return appMode === 'json' ? 'json' : 'text';
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
  return (
    !parsed.print &&
    parsed.mode === undefined &&
    (parsed.help === true || parsed.listModels !== undefined)
  );
}

async function prepareInitialMessage(
  parsed: Args,
  autoResizeImages: boolean,
  stdinContent?: string,
): Promise<{
  initialMessage?: string;
  initialImages?: ImageContent[];
}> {
  if (parsed.fileArgs.length === 0) {
    return buildInitialMessage({ parsed, stdinContent });
  }

  const { text, images } = await processFileArguments(parsed.fileArgs, {
    autoResizeImages,
  });
  return buildInitialMessage({
    parsed,
    fileText: text,
    fileImages: images,
    stdinContent,
  });
}

function validateForkFlags(parsed: Args): void {
  if (!parsed.fork) return;

  const conflictingFlags = [
    parsed.session ? '--session' : undefined,
    parsed.continue ? '--continue' : undefined,
    parsed.resume ? '--resume' : undefined,
    parsed.noSession ? '--no-session' : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  if (conflictingFlags.length > 0) {
    console.error(
      chalk.red(
        `Error: --fork cannot be combined with ${conflictingFlags.join(', ')}`,
      ),
    );
    process.exit(1);
  }
}

function validateSessionIdFlags(parsed: Args): void {
  if (parsed.sessionId === undefined) return;

  const conflictingFlags = [
    parsed.session ? '--session' : undefined,
    parsed.continue ? '--continue' : undefined,
    parsed.resume ? '--resume' : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  if (conflictingFlags.length > 0) {
    console.error(
      chalk.red(
        `Error: --session-id cannot be combined with ${conflictingFlags.join(', ')}`,
      ),
    );
    process.exit(1);
  }

  try {
    assertValidSessionId(parsed.sessionId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

async function createSessionManager(
  parsed: Args,
  cwd: string,
  settingsManager: SettingsManager,
): Promise<SessionManager> {
  if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
    return SessionManager.inMemory(
      cwd,
      parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined,
    );
  }

  if (parsed.fork) {
    console.error(chalk.red('--fork is not available in thin-client mode.'));
    process.exit(1);
  }

  if (parsed.session) {
    const auth = getStoredAuth();
    if (auth) return await loadRemoteSessionOrExit(auth, parsed.session, cwd);
    console.error(chalk.red('--session requires login.'));
    process.exit(1);
  }

  if (parsed.resume) {
    try {
      const auth = getStoredAuth();
      if (!auth) {
        console.error(chalk.red('--resume requires login.'));
        process.exit(1);
      }
      const remoteSessions = await listRemoteSessions(auth).catch((e) => {
        console.error(chalk.red(`Failed to list sessions: ${e.message}`));
        process.exit(1);
      });
      if (remoteSessions.length === 0) {
        console.log(chalk.dim('No sessions found.'));
        process.exit(0);
      }
      const selected = await selectRemoteSession(
        remoteSessions,
        settingsManager,
      );
      if (!selected) {
        console.log(chalk.dim('No session selected'));
        process.exit(0);
      }
      return await loadRemoteSessionOrExit(auth, selected.id, cwd);
    } finally {
      stopThemeWatcher();
    }
  }

  if (parsed.continue) {
    const auth = getStoredAuth();
    if (!auth) {
      console.error(chalk.red('--continue requires login.'));
      process.exit(1);
    }
    const remoteSessions = await listRemoteSessions(auth).catch((e) => {
      console.error(chalk.red(`Failed to list sessions: ${e.message}`));
      process.exit(1);
    });
    if (remoteSessions.length === 0) {
      console.error(chalk.red('No previous session.'));
      process.exit(1);
    }
    return await loadRemoteSessionOrExit(auth, remoteSessions[0].id, cwd);
  }

  if (parsed.sessionId) {
    const auth = getStoredAuth();
    if (auth) return await loadRemoteSessionOrExit(auth, parsed.sessionId, cwd);
  }

  return SessionManager.create(cwd, { id: parsed.sessionId });
}

async function loadRemoteSessionOrExit(
  auth: { url: string; token: string },
  sessionId: string,
  cwd: string,
): Promise<SessionManager> {
  try {
    const { session, messages } = await fetchRemoteMessages(auth, sessionId);
    return SessionManager.fromRemote(cwd, session.id, messages);
  } catch (err) {
    console.error(
      chalk.red(
        `Failed to load session '${sessionId}': ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
}

async function selectRemoteSession(
  sessions: RemoteSession[],
  settingsManager: SettingsManager,
): Promise<RemoteSession | undefined> {
  const { selectSession } = await import('./cli/session-picker.ts');
  const indexById = new Map(sessions.map((s) => [s.id, s] as const));
  const adapted = sessions.map((s) => ({
    id: s.id,
    path: s.id,
    created: new Date(s.createdAt),
    parentSessionPath: undefined,
    cwd: undefined,
    messageCount: 0,
    title: s.title ?? undefined,
  })) as any;
  const selectedPath = await selectSession(
    async () => adapted,
    async () => adapted,
    settingsManager,
  );
  return selectedPath ? indexById.get(selectedPath) : undefined;
}

function buildSessionOptions(
  parsed: Args,
  scopedModels: ScopedModel[],
  hasExistingSession: boolean,
  modelRegistry: ModelRegistry,
  remoteDefaults: {
    model?: string | null;
    thinkingLevel?: string | null;
  } | null,
): {
  options: CreateAgentSessionOptions;
  cliThinkingFromModel: boolean;
  diagnostics: AgentSessionRuntimeDiagnostic[];
} {
  const options: CreateAgentSessionOptions = {};
  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  let cliThinkingFromModel = false;

  // Model from CLI
  // - supports --provider <name> --model <pattern>
  // - supports --model <provider>/<pattern>
  if (parsed.model) {
    const resolved = resolveCliModel({
      cliModel: parsed.model,
      cliThinking: parsed.thinking,
      modelRegistry,
    });
    if (resolved.warning) {
      diagnostics.push({ type: 'warning', message: resolved.warning });
    }
    if (resolved.error) {
      diagnostics.push({ type: 'error', message: resolved.error });
    }
    if (resolved.model) {
      options.model = resolved.model;
      // Allow "--model <pattern>:<thinking>" as a shorthand.
      // Explicit --thinking still takes precedence (applied later).
      if (!parsed.thinking && resolved.thinkingLevel) {
        options.thinkingLevel = resolved.thinkingLevel;
        cliThinkingFromModel = true;
      }
    }
  }

  if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
    // Default model comes from the web backend's per-user preferences
    // (shared with web chat + IM). The CLI no longer stores a default
    // locally — see /api/cli/preferences. If the server preference is
    // set and matches one of the scoped models, use it; otherwise fall
    // back to the first scoped model.
    const savedModelId = remoteDefaults?.model ?? null;
    const savedInScope = savedModelId
      ? scopedModels.find(
          (sm) =>
            modelsAreEqual(sm.model, { id: savedModelId } as never) ||
            sm.model.id === savedModelId,
        )
      : undefined;

    if (savedInScope) {
      options.model = savedInScope.model;
      if (!parsed.thinking && savedInScope.thinkingLevel) {
        options.thinkingLevel = savedInScope.thinkingLevel;
      }
    } else {
      options.model = scopedModels[0].model;
      if (!parsed.thinking && scopedModels[0].thinkingLevel) {
        options.thinkingLevel = scopedModels[0].thinkingLevel;
      }
    }
  }

  // Default thinking level from the web backend (only applies when the
  // CLI flag --thinking wasn't passed and no scoped model pinned one).
  if (!parsed.thinking && remoteDefaults?.thinkingLevel) {
    const tl = remoteDefaults.thinkingLevel;
    if (
      tl === 'off' ||
      tl === 'minimal' ||
      tl === 'low' ||
      tl === 'medium' ||
      tl === 'high' ||
      tl === 'xhigh'
    ) {
      options.thinkingLevel = tl;
    }
  }

  // Thinking level from CLI (takes precedence over server default)
  if (parsed.thinking) {
    options.thinkingLevel = parsed.thinking;
  }

  // Scoped models for Ctrl+P cycling
  // Keep thinking level undefined when not explicitly set in the model pattern.
  // Undefined means "inherit current session thinking level" during cycling.
  if (scopedModels.length > 0) {
    options.scopedModels = scopedModels.map((sm) => ({
      model: sm.model,
      thinkingLevel: sm.thinkingLevel,
    }));
  }

  // API key from CLI - set in authStorage
  // (handled by caller before createAgentSession)

  // Tools
  if (parsed.noTools) {
    options.noTools = 'all';
  } else if (parsed.noBuiltinTools) {
    options.noTools = 'builtin';
  }
  if (parsed.tools) {
    options.tools = [...parsed.tools];
  }
  if (parsed.excludeTools) {
    options.excludeTools = [...parsed.excludeTools];
  }

  return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(
  cwd: string,
  paths: string[] | undefined,
): string[] | undefined {
  return paths?.map((value) =>
    isLocalPath(value) ? resolvePath(value, cwd) : value,
  );
}

async function promptForMissingSessionCwd(
  issue: SessionCwdIssue,
  settingsManager: SettingsManager,
): Promise<string | undefined> {
  return showStartupSelector(
    settingsManager,
    formatMissingSessionCwdPrompt(issue),
    [
      { label: 'Continue', value: issue.fallbackCwd },
      { label: 'Cancel', value: undefined },
    ],
  );
}

export interface MainOptions {
  extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
  resetTimings();
  const offlineMode =
    args.includes('--offline') || isTruthyEnvFlag(process.env.PI_OFFLINE);
  if (offlineMode) {
    process.env.PI_OFFLINE = '1';
    process.env.PI_SKIP_VERSION_CHECK = '1';
  }

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  applyHttpProxySettings(
    bootstrapSettingsManager.getGlobalSettings().httpProxy,
  );
  configureHttpDispatcher();

  if (await handleLoginCommand(args)) {
    return;
  }

  if (await handleAuthCommand(args)) {
    return;
  }

  if (await handleMcpCommand(args)) {
    return;
  }

  if (await handleRemoteCommand(args)) {
    return;
  }

  if (
    await handlePackageCommand(args, {
      extensionFactories: options?.extensionFactories,
    })
  ) {
    const exitCode = process.exitCode ?? 0;
    if (
      process.platform === 'win32' &&
      exitCode === 0 &&
      args[0] === 'update'
    ) {
      // We normally prefer process.exit(0) for package commands so bad extensions cannot keep
      // one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
      // runs during teardown; let successful `pi update` drain naturally instead.
      // https://github.com/nodejs/node/issues/56645
      return;
    }
    process.exit(exitCode);
    return;
  }

  if (
    await handleConfigCommand(args, {
      extensionFactories: options?.extensionFactories,
    })
  ) {
    return;
  }

  // Auth gate: every primary mode (interactive, -p, --list-models, etc.)
  // requires an Agentboster auth token. Subcommands (login/install/...)
  // are dispatched above and exit before reaching here.
  if (!getStoredAuth()) {
    console.error(
      'Not logged in. Run `agentboster-cli login` first, then re-run this command.',
    );
    process.exit(1);
  }

  const parsed = parseArgs(args);
  // Clean up temp session files left by a previous crashed run.
  cleanStaleTempSessions();
  if (parsed.diagnostics.length > 0) {
    for (const d of parsed.diagnostics) {
      const color = d.type === 'error' ? chalk.red : chalk.yellow;
      console.error(
        color(`${d.type === 'error' ? 'Error' : 'Warning'}: ${d.message}`),
      );
    }
    if (parsed.diagnostics.some((d) => d.type === 'error')) {
      process.exit(1);
    }
  }
  time('parseArgs');

  if (parsed.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (parsed.export) {
    let result: string;
    try {
      const outputPath =
        parsed.messages.length > 0 ? parsed.messages[0] : undefined;
      result = await exportFromFile(parsed.export, outputPath);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to export session';
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
    console.log(`Exported to: ${result}`);
    process.exit(0);
  }

  let appMode = resolveAppMode(
    parsed,
    process.stdin.isTTY,
    process.stdout.isTTY,
  );
  const shouldTakeOverStdout =
    appMode !== 'interactive' && !isPlainRuntimeMetadataCommand(parsed);
  if (shouldTakeOverStdout) {
    takeOverStdout();
  }

  if (parsed.mode === 'rpc' && parsed.fileArgs.length > 0) {
    console.error(
      chalk.red('Error: @file arguments are not supported in RPC mode'),
    );
    process.exit(1);
  }

  validateForkFlags(parsed);
  validateSessionIdFlags(parsed);

  // Run migrations (pass cwd for project-local migrations)
  const { migratedAuthProviders: migratedProviders, deprecationWarnings } =
    runMigrations(cwd);
  time('runMigrations');

  const startupSettingsManager = SettingsManager.create(cwd, agentDir);
  reportDiagnostics(
    collectSettingsDiagnostics(
      startupSettingsManager,
      'startup session lookup',
    ),
  );

  // Experimental first-time setup: theme choice and analytics opt-in.
  // Runs before any runtime services are created so the chosen settings apply everywhere.
  if (
    appMode === 'interactive' &&
    !parsed.help &&
    parsed.listModels === undefined &&
    shouldRunFirstTimeSetup()
  ) {
    await showFirstTimeSetup(startupSettingsManager);
    time('firstTimeSetup');
  }

  // Decide the final runtime cwd before creating cwd-bound runtime services.
  // --session and --resume may select a session from another project, so project-local
  // settings, resources, provider registrations, and models must be resolved only after
  // the target session cwd is known.
  let sessionManager = await createSessionManager(
    parsed,
    cwd,
    startupSettingsManager,
  );
  const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
  if (missingSessionCwdIssue) {
    if (appMode === 'interactive') {
      const selectedCwd = await promptForMissingSessionCwd(
        missingSessionCwdIssue,
        startupSettingsManager,
      );
      if (!selectedCwd) {
        process.exit(0);
      }
      sessionManager = SessionManager.open(
        missingSessionCwdIssue.sessionFile!,
        undefined,
        selectedCwd,
      );
    } else {
      console.error(
        chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message),
      );
      process.exit(1);
    }
  }
  if (parsed.name !== undefined) {
    const name = parsed.name.trim();
    if (!name) {
      console.error(chalk.red('Error: --name requires a non-empty value'));
      process.exit(1);
    }
    sessionManager.appendSessionInfo(name);
    // Mirror to the web DB so the title shows up in /resume and the web UI.
    const auth = getStoredAuth();
    if (auth) {
      await patchRemoteSession(auth, sessionManager.getSessionId(), {
        title: name,
      }).catch(() => {});
    }
  }
  time('createSessionManager');

  const trustStore = new ProjectTrustStore(agentDir);
  const sessionCwd = sessionManager.getCwd();
  const autoTrustOnReloadCwd =
    parsed.projectTrustOverride === undefined &&
    !hasTrustRequiringProjectResources(sessionCwd)
      ? sessionCwd
      : undefined;
  const trustPromptMode: AppMode =
    parsed.help || parsed.listModels !== undefined ? 'print' : appMode;
  const projectTrustByCwd = new Map<string, boolean>();

  const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
  const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
  const resolvedPromptTemplatePaths = resolveCliPaths(
    cwd,
    parsed.promptTemplates,
  );
  const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
  const authStorage = AuthStorage.create();
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
    projectTrustContext,
  }) => {
    const isInitialRuntime = sessionStartEvent === undefined;
    const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
    const cachedProjectTrust = projectTrustByCwd.get(cwd);
    const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
    const shouldResolveProjectTrust =
      parsed.projectTrustOverride === undefined &&
      cachedProjectTrust === undefined &&
      hasTrustRequiringResources;
    const projectTrusted = shouldResolveProjectTrust
      ? false
      : (cachedProjectTrust ??
        parsed.projectTrustOverride ??
        (!hasTrustRequiringResources || trustStore.get(cwd) === true));
    const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted,
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      settingsManager: runtimeSettingsManager,
      extensionFlagValues: parsed.unknownFlags,
      resourceLoaderReloadOptions: shouldResolveProjectTrust
        ? {
            resolveProjectTrust: async ({ extensionsResult }) => {
              const trusted = await resolveProjectTrusted({
                cwd,
                trustStore,
                trustOverride: parsed.projectTrustOverride,
                defaultProjectTrust:
                  startupSettingsManager.getDefaultProjectTrust(),
                extensionsResult,
                projectTrustContext:
                  projectTrustContext ??
                  createProjectTrustContext({
                    cwd,
                    mode: isInitialRuntime ? trustPromptMode : appMode,
                    settingsManager: startupSettingsManager,
                    hasUI:
                      isInitialRuntime && trustPromptMode === 'interactive',
                  }),
                onExtensionError: (message) =>
                  projectTrustDiagnostics.push({ type: 'warning', message }),
              });
              projectTrustByCwd.set(cwd, trusted);
              return trusted;
            },
          }
        : undefined,
      resourceLoaderOptions: {
        additionalExtensionPaths: resolvedExtensionPaths,
        additionalSkillPaths: resolvedSkillPaths,
        additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
        additionalThemePaths: resolvedThemePaths,
        noExtensions: parsed.noExtensions,
        noSkills: parsed.noSkills,
        noPromptTemplates: parsed.noPromptTemplates,
        noThemes: parsed.noThemes,
        noContextFiles: parsed.noContextFiles,
        systemPrompt: parsed.systemPrompt,
        appendSystemPrompt: parsed.appendSystemPrompt,
        extensionFactories: options?.extensionFactories,
      },
    });
    const { settingsManager, modelRegistry, resourceLoader } = services;
    await injectRemoteModels(modelRegistry);
    const diagnostics: AgentSessionRuntimeDiagnostic[] = [
      ...projectTrustDiagnostics,
      ...services.diagnostics,
      ...collectSettingsDiagnostics(settingsManager, 'runtime creation'),
      ...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: 'error' as const,
        message: `Failed to load extension "${path}": ${error}`,
      })),
    ];

    const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
    const scopedModels =
      modelPatterns && modelPatterns.length > 0
        ? await resolveModelScope(modelPatterns, modelRegistry)
        : [];
    // Pull the user's model preferences from the web backend so the
    // initial model + thinking level match what the user picked in the
    // web UI (and vice versa). The CLI no longer keeps a local default.
    const authForPrefs = getStoredAuth();
    const remoteDefaults = authForPrefs
      ? await fetchUserPreferences(authForPrefs.url, authForPrefs.token).catch(
          () => null,
        )
      : null;

    const {
      options: sessionOptions,
      cliThinkingFromModel,
      diagnostics: sessionOptionDiagnostics,
    } = buildSessionOptions(
      parsed,
      scopedModels,
      sessionManager.buildSessionContext().messages.length > 0,
      modelRegistry,
      remoteDefaults,
    );
    diagnostics.push(...sessionOptionDiagnostics);

    // Validate the chosen model against the server catalog when
    // logged in. Mirrors the IM /model command's allowlist check so
    // the user gets a friendly "not in the allowed list" message
    // instead of a 500 from the backend later.
    if (sessionOptions.model) {
      const auth = getStoredAuth();
      if (auth) {
        const catalogIds = await fetchRemoteModels(auth.url, auth.token).then(
          (rows) => rows?.models.map((m) => m.id) ?? null,
          () => null,
        );
        if (catalogIds && catalogIds.length > 0) {
          const wanted = sessionOptions.model.id;
          if (!catalogIds.includes(wanted)) {
            const suggestion = catalogIds.slice().sort().join(', ');
            console.error(
              chalk.red(
                `Model "${wanted}" is not in the server catalog. Allowed models: ${suggestion}`,
              ),
            );
            process.exit(1);
          }
        }
      }
    }

    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: sessionOptions.model,
      thinkingLevel: sessionOptions.thinkingLevel,
      scopedModels: sessionOptions.scopedModels,
      tools: sessionOptions.tools,
      excludeTools: sessionOptions.excludeTools,
      noTools: getStoredAuth() ? ('builtin' as const) : sessionOptions.noTools,
      customTools: sessionOptions.customTools,
      // Enable the built-in computer-use tools when running under the
      // desktop host. They forward every call to the desktop via the
      // ExtensionUIContext.computerUse reverse-RPC channel; harmless in
      // other modes (each call rejects with a clear error).
      enableComputerUse: appMode === 'rpc',
      streamFnOverride: await resolveStreamFnOverride(
        sessionManager,
        undefined,
        undefined,
        parsed.yolo === true,
        undefined,
        () => readMergedAgentsMd(resourceLoader),
        undefined,
        undefined,
        () => settingsManager.getClientSpoof(),
      ),
    });
    const overrideWithEvents = await resolveStreamFnOverride(
      sessionManager,
      (event) => {
        void created.session.addWorkflowSubagentEvent(event);
      },
      (event) => {
        void created.session.addWorkflowSubagentBatchEvent(event);
      },
      parsed.yolo === true,
      () => created.session.consumeRegenerateIntent(),
      () => readMergedAgentsMd(created.session.resourceLoader),
      () => created.session.planMode,
      () => created.session.thinkingLevel,
      () => settingsManager.getClientSpoof(),
    );
    if (overrideWithEvents) {
      created.session.agent.streamFn = overrideWithEvents;
    }
    const cliThinkingOverride =
      parsed.thinking !== undefined || cliThinkingFromModel;
    if (created.session.model && cliThinkingOverride) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }

    // When logged in, wrap session.compact so compaction results are
    // POSTed back to the web server after local summarization.
    const auth = getStoredAuth();
    if (auth) {
      const originalCompact = created.session.compact.bind(created.session);
      created.session.compact = async (customInstructions?: string) => {
        const result = await originalCompact(customInstructions);
        await postCompactionResult(
          auth,
          created.session.sessionId,
          result,
        ).catch(() => {});
        return result;
      };
    }

    return {
      ...created,
      services,
      diagnostics,
    };
  };
  time('createRuntime');
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
  time('createAgentSessionRuntime');
  const { services, session, modelFallbackMessage } = runtime;
  const { settingsManager, modelRegistry, resourceLoader } = services;
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

  if (parsed.help) {
    const extensionFlags = resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => Array.from(extension.flags.values()));
    printHelp(extensionFlags);
    process.exit(0);
  }

  if (parsed.listModels !== undefined) {
    const searchPattern =
      typeof parsed.listModels === 'string' ? parsed.listModels : undefined;
    await listModels(modelRegistry, searchPattern);
    process.exit(0);
  }

  // Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
  let stdinContent: string | undefined;
  if (appMode !== 'rpc') {
    stdinContent = await readPipedStdin();
    if (stdinContent !== undefined && appMode === 'interactive') {
      appMode = 'print';
    }
  }
  time('readPipedStdin');

  const { initialMessage, initialImages } = await prepareInitialMessage(
    parsed,
    settingsManager.getImageAutoResize(),
    stdinContent,
  );
  time('prepareInitialMessage');
  initTheme(settingsManager.getTheme(), appMode === 'interactive');
  time('initTheme');

  // Show deprecation warnings in interactive mode
  if (appMode === 'interactive' && deprecationWarnings.length > 0) {
    await showDeprecationWarnings(deprecationWarnings);
  }

  time('resolveModelScope');
  reportDiagnostics(runtime.diagnostics);
  if (runtime.diagnostics.some((diagnostic) => diagnostic.type === 'error')) {
    if (
      runtime.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Failed to load extension'),
      )
    ) {
      console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
    }
    process.exit(1);
  }
  time('createAgentSession');

  if (appMode !== 'interactive' && !session.model) {
    console.error(chalk.red(formatNoModelsAvailableMessage()));
    process.exit(1);
  }

  const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
  if (startupBenchmark && appMode !== 'interactive') {
    console.error(
      chalk.red('Error: PI_STARTUP_BENCHMARK only supports interactive mode'),
    );
    process.exit(1);
  }

  if (appMode === 'rpc') {
    printTimings();
    await runRpcMode(runtime, {
      backendUrl: parsed.backendUrl,
      sessionId: parsed.cliSessionId,
    });
  } else if (appMode === 'interactive') {
    const interactiveMode = new InteractiveMode(runtime, {
      migratedProviders,
      modelFallbackMessage,
      autoTrustOnReloadCwd,
      initialMessage,
      initialImages,
      initialMessages: parsed.messages,
      verbose: parsed.verbose,
      permissionMode: parsed.yolo === true ? 'yolo' : 'manual',
    });
    if (startupBenchmark) {
      await interactiveMode.init();
      time('interactiveMode.init');
      // Give the TUI's stdin handler a brief chance to consume terminal query replies
      // (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
      await new Promise((resolve) => setTimeout(resolve, 150));
      interactiveMode.stop();
      stopThemeWatcher();
      printTimings();
      if (process.stdout.writableLength > 0) {
        await new Promise<void>((resolve) =>
          process.stdout.once('drain', resolve),
        );
      }
      if (process.stderr.writableLength > 0) {
        await new Promise<void>((resolve) =>
          process.stderr.once('drain', resolve),
        );
      }
      return;
    }

    printTimings();
    await interactiveMode.run();
  } else {
    printTimings();
    const exitCode = await runPrintMode(runtime, {
      mode: toPrintOutputMode(appMode),
      messages: parsed.messages,
      initialMessage,
      initialImages,
    });
    stopThemeWatcher();
    restoreStdout();
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }
}

/**
 * POST a compaction result to the web backend so the server-side
 * session history is kept in sync with the CLI's local compaction.
 */
async function postCompactionResult(
  auth: { url: string; token: string },
  sessionId: string,
  result: { summary: string; firstKeptEntryId: string },
): Promise<void> {
  const root = auth.url.replace(/\/$/, '');
  await fetch(
    `${root}/api/cli/sessions/${encodeURIComponent(sessionId)}/compact`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.token}`,
        cookie: `clawless-auth=${auth.token}`,
      },
      body: JSON.stringify({
        summary: result.summary,
        firstKeptUiMessageId: result.firstKeptEntryId,
      }),
    },
  );
}

/**
 * Execute a local-tool-request from the web backend and POST the
 * result back. The web workflow blocks on localToolResultHookBuilder
 * until we respond at /api/ai/[runId]/tool-result.
 *
 * Tool names match the web backend's local_* vocabulary:
 *   local_read_file     → read a local file
 *   local_write_file    → write a local file
 *   local_exec          → run a shell command locally
 *   local_grep          → ripgrep search on the local filesystem
 *   local_ask_question  → ask the user a question in the TUI
 */
async function handleLocalToolRequest(
  auth: { url: string; token: string },
  runId: string,
  toolCallId: string,
  toolName: string,
  toolInput: unknown,
  yolo: boolean,
  options?: {
    remoteTarget?: { nodeId: string } | null;
    sessionId?: string;
  },
): Promise<void> {
  const input = toolInput as Record<string, unknown>;
  let result: { ok: boolean; output?: unknown; error?: string };

  // local_ask_question is not a security-sensitive operation (no file/shell
  // access), so skip the L0/L1/L2 gate entirely.
  const isQuestion = toolName === 'local_ask_question';

  // Security gate: L0 blocks immediately, L2 requires user confirmation.
  // --yolo skips both tiers (auto-approve every local_* invocation).
  const command =
    toolName === 'local_exec'
      ? String(input.command ?? '')
      : formatToolRequest(toolName, toolInput);
  const decision = await (yolo || isQuestion
    ? Promise.resolve({
        ok: true,
        autoApprove: true,
        level: 'l0' as const,
        message: 'yolo (skipped)',
      })
    : evaluateLocalCommand(command, auth));

  if (!decision.ok) {
    // L0 block — reject immediately.
    await postToolResult(auth, runId, toolCallId, {
      ok: false,
      error: `Security blocked: ${decision.message}`,
    });
    return;
  }

  if (!decision.autoApprove) {
    // L2 — ask the user. In -p (headless) mode there's no TUI; auto-allow
    // would be unsafe, so block with a clear message.
    if (process.stdin.isTTY !== true) {
      await postToolResult(auth, runId, toolCallId, {
        ok: false,
        error: `Requires confirmation but no TTY available: ${command}`,
      });
      return;
    }
    const rl = createInterfacePromises({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `\n[security] ${decision.message}\n  ${command}\nAllow? [y/N] `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      await postToolResult(auth, runId, toolCallId, {
        ok: false,
        error: 'Denied by user',
      });
      return;
    }
  }

  try {
    // Remote execution via /switch. When a target node is set, forward
    // every local_* tool call (except local_ask_question, which needs
    // the CLI's TTY) to /api/cli/exec-on-agentd. The Web server proxies
    // to agentd with credentials the CLI doesn't hold. Tool names and
    // schemas are unchanged — only the execution location moves.
    //
    // This branch is wrapped in its own try/catch so a network or parse
    // failure reports a clean error to the workflow via postToolResult
    // and returns, rather than falling through to the outer catch and
    // double-posting (the success/failure branches below already call
    // postToolResult before returning).
    if (
      options?.remoteTarget &&
      toolName !== 'local_ask_question' &&
      options.sessionId
    ) {
      try {
        const root = auth.url.replace(/\/$/, '');
        const resp = await fetch(`${root}/api/cli/exec-on-agentd`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
            cookie: `clawless-auth=${auth.token}`,
          },
          body: JSON.stringify({
            nodeId: options.remoteTarget.nodeId,
            sessionId: options.sessionId,
            toolName,
            toolInput,
          }),
        });

        if (!resp.ok) {
          const body = (await resp.json().catch(() => null)) as {
            ok: boolean;
            error?: string;
          } | null;
          await postToolResult(auth, runId, toolCallId, {
            ok: false,
            error: body?.error ?? `Remote exec HTTP ${resp.status}`,
          });
          return;
        }

        const body = (await resp.json().catch(() => null)) as {
          ok: boolean;
          result?: { success: boolean; data?: string; error?: string };
        } | null;
        if (!body || !body.ok || !body.result) {
          await postToolResult(auth, runId, toolCallId, {
            ok: false,
            error:
              body?.result?.error ??
              'Remote exec returned no result or invalid JSON',
          });
          return;
        }

        // agentd returns the tool output as a JSON-encoded string in
        // `data`. Keep the output shape identical to the local path so
        // the LLM sees no difference.
        let output: unknown = body.result.data;
        if (typeof output === 'string') {
          try {
            output = JSON.parse(output);
          } catch {
            // Not JSON — pass through as a plain string. Many agentd
            // tools (e.g. read_file) return raw text, not JSON.
          }
        }
        await postToolResult(auth, runId, toolCallId, {
          ok: body.result.success,
          output: body.result.success ? output : undefined,
          error: body.result.success ? undefined : body.result.error,
        });
        return;
      } catch (error) {
        await postToolResult(auth, runId, toolCallId, {
          ok: false,
          error: `Remote exec failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
    }

    switch (toolName) {
      case 'local_read_file': {
        const path = String(input.path ?? '');
        const fs = await import('node:fs/promises');
        result = { ok: true, output: await fs.readFile(path, 'utf8') };
        break;
      }
      case 'local_write_file': {
        const path = String(input.path ?? '');
        const content = String(input.content ?? '');
        const fs = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, content, 'utf8');
        result = {
          ok: true,
          output: `Wrote ${content.length} bytes to ${path}`,
        };
        break;
      }
      case 'local_exec': {
        const command = String(input.command ?? '');
        const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
        const { spawn } = await import('node:child_process');
        result = await new Promise((resolve) => {
          const child = spawn(command, {
            shell: process.env.SHELL ?? '/bin/sh',
            cwd: typeof cwd === 'string' ? cwd : process.cwd(),
            env: process.env,
          });
          let stdout = '';
          let stderr = '';
          const MAX = 100_000;
          child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX)
              stdout += chunk.toString('utf8').slice(0, MAX - stdout.length);
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX)
              stderr += chunk.toString('utf8').slice(0, MAX - stderr.length);
          });
          child.on('error', (err) =>
            resolve({ ok: false, error: err.message }),
          );
          child.on('close', (code) => {
            if (code === 0) {
              resolve({
                ok: true,
                output: stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout,
              });
            } else {
              resolve({
                ok: false,
                error: `Exit ${code}.\n[stdout]\n${stdout}\n[stderr]\n${stderr}`,
              });
            }
          });
        });
        break;
      }
      case 'local_grep': {
        // Reuse the pi-inherited grep tool definition so rg auto-download,
        // --json streaming, match limit, and truncation all stay in sync
        // with the local CLI implementation. The ToolDefinition.execute
        // signature is (toolCallId, params, signal?, onUpdate?, ctx); we
        // pass undefined for the optional slots and a minimal ctx stub.
        const { createGrepToolDefinition } = await import(
          './core/tools/grep.ts'
        );
        const definition = createGrepToolDefinition(process.cwd());
        const grepResult = await definition.execute(
          toolCallId,
          {
            pattern: String(input.pattern ?? ''),
            path: typeof input.path === 'string' ? input.path : undefined,
            glob: typeof input.glob === 'string' ? input.glob : undefined,
            ignoreCase:
              typeof input.ignoreCase === 'boolean'
                ? input.ignoreCase
                : undefined,
            literal:
              typeof input.literal === 'boolean' ? input.literal : undefined,
            context:
              typeof input.context === 'number' ? input.context : undefined,
            limit: typeof input.limit === 'number' ? input.limit : undefined,
          },
          undefined,
          undefined,
          // ExtensionContext is only consumed by tools that need UI / cwd
          // hooks (renderCall/renderResult paths). grep's execute ignores
          // it. Cast through unknown to avoid pulling the full type.
          {} as never,
        );
        // grepResult.content is an array of TextContent / ImageContent;
        // join the text fields for the web backend.
        const text = (grepResult.content ?? [])
          .map((block) => ('text' in block ? (block.text ?? '') : ''))
          .join('\n');
        result = { ok: true, output: text };
        break;
      }
      case 'local_ask_question': {
        const prompts = Array.isArray(input.prompts)
          ? (input.prompts as Array<Record<string, unknown>>)
          : [];
        if (process.stdin.isTTY !== true) {
          result = {
            ok: false,
            error: 'Cannot ask a question without a TTY (running in -p mode).',
          };
          break;
        }
        const rl = createInterfacePromises({
          input: process.stdin,
          output: process.stdout,
        });
        const answers: string[] = [];
        for (const prompt of prompts) {
          const question = String(prompt.question ?? '');
          const options = Array.isArray(prompt.options)
            ? (prompt.options as string[])
            : undefined;
          const multiple = Boolean(prompt.multiple);
          if (options && options.length > 0) {
            const lines = options.map((o, i) => `  ${i + 1}. ${o}`);
            const hint = multiple ? ' (comma-separate for multiple)' : '';
            const raw = await rl.question(
              `\n❓ ${question}\n${lines.join('\n')}\nChoice${hint}: `,
            );
            const picks = raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const selected: string[] = [];
            for (const pick of picks) {
              const idx = Number.parseInt(pick, 10);
              if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
                selected.push(options[idx - 1]!);
              } else if (options.includes(pick)) {
                selected.push(pick);
              }
            }
            if (!multiple && selected.length > 1)
              answers.push(selected[0] ?? '');
            else answers.push(selected.join(', '));
          } else {
            const raw = await rl.question(`\n❓ ${question}\n> `);
            answers.push(raw.trim());
          }
        }
        rl.close();
        result = { ok: true, output: answers };
        break;
      }
      default:
        result = { ok: false, error: `Unknown local tool: ${toolName}` };
    }
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await postToolResult(auth, runId, toolCallId, result);
}

/**
 * POST a tool result back to the web backend. Best-effort: if the
 * request fails, the server will time out on its own.
 */
async function postToolResult(
  auth: { url: string; token: string },
  runId: string,
  toolCallId: string,
  result: { ok: boolean; output?: unknown; error?: string },
): Promise<void> {
  const root = auth.url.replace(/\/$/, '');
  await fetch(`${root}/api/ai/${encodeURIComponent(runId)}/tool-result`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.token}`,
      cookie: `clawless-auth=${auth.token}`,
    },
    body: JSON.stringify({
      toolCallId,
      ok: result.ok,
      output: result.output,
      error: result.error,
    }),
  }).catch(() => {
    // Best-effort.
  });
}

/**
 * Pull the model catalog from the web backend and inject it into pi's
 * ModelRegistry. No-op when not logged in (falls back to pi's local
 * provider registry).
 */
async function injectRemoteModels(modelRegistry: ModelRegistry): Promise<void> {
  const auth = getStoredAuth();
  if (!auth) return;
  const remote = await fetchRemoteModels(auth.url, auth.token);
  if (!remote || remote.models.length === 0) return;
  modelRegistry.setRemoteModels(remoteModelsToPiModels(remote));
  // Mark AuthStorage as having agentboster credentials so pi's
  // internal is-authed checks (footer, model picker auth status,
  // hasConfiguredAuth) all pass without prompting for OAuth.
  modelRegistry.authStorage.set('agentboster', {
    type: 'api_key',
    key: 'agentboster-adapter',
  } as never);
}

/**
 * Read and merge the content of AGENTS.md files the resource loader has
 * discovered for this session. Each file is prefixed with an HTML comment
 * annotation showing its source path, mirroring the format the agentd build
 * produces, so backend-injected prompts look identical regardless of channel.
 *
 * Returns undefined when no files were loaded so the stream-fn caller omits
 * the field entirely and the Web backend leaves the stored prompt untouched.
 */
function readMergedAgentsMd(resourceLoader: {
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
}): string | undefined {
  const files = resourceLoader.getAgentsFiles().agentsFiles;
  if (files.length === 0) return undefined;
  return (
    files
      .map((file) => {
        const content = file.content.trim();
        if (content.length === 0) return '';
        return `<!-- From: ${file.path} -->\n${content}`;
      })
      .filter((entry) => entry.length > 0)
      .join('\n\n') || undefined
  );
}

/**
 * Resolve an optional stream function override for the Agentboster web backend.
 *
 * When `AGENTBOSTER_URL` is set and `~/.config/agentboster-cli/config.json` contains a
 * saved auth token, we build a streamFn that talks to the web backend. This
 * lets pi run as a thin client to the Agentboster server. When the env var
 * is absent, returns undefined and pi uses its built-in provider SDKs.
 */
async function resolveStreamFnOverride(
  sessionManager: { getSessionId: () => string },
  onSubagentEvent?: (event: {
    subagentId: string;
    subagentName: string;
    event: 'started' | 'completed' | 'failed';
    task: string;
    summary?: string;
    error?: string;
    steps?: number;
    modelId?: string;
  }) => void,
  onSubagentBatchEvent?: (event: {
    batchId: string;
    event: 'spawned' | 'completed' | 'cancelled';
    concurrencyLimit: number;
    total: number;
    succeeded?: number;
    failed?: number;
    cancelled?: number;
    summary?: string;
  }) => void,
  yolo: boolean = false,
  consumeRegenerateIntent?: () => {
    messageId: string;
    metadata?: unknown;
  } | null,
  getAgentsMd?: () => string | undefined,
  getPlanMode?: () => boolean,
  getThinkingLevel?: () => string | undefined,
  getClientSpoof?: () => string | undefined,
): Promise<StreamFn | undefined> {
  const auth = getStoredAuth();
  if (!auth) {
    return undefined;
  }
  // Use the SessionManager's id as the remote session identifier so
  // the Web DB row and the local jsonl file stay correlated. Allow
  // override via AGENTBOSTER_SESSION_ID for one-off debugging.
  const envOverride = process.env.AGENTBOSTER_SESSION_ID;
  return createAgentbosterStreamFn({
    getAuth: () => ({ baseUrl: auth.url, token: auth.token }),
    getSessionId: () => envOverride ?? sessionManager.getSessionId(),
    clientId: process.env.AGENTBOSTER_CLIENT_ID ?? 'local-cli',
    label: 'agentboster-cli',
    model: process.env.AGENTBOSTER_MODEL ?? null,
    consumeRegenerateIntent,
    ...(getAgentsMd ? { getAgentsMd } : {}),
    ...(getPlanMode ? { getPlanMode } : {}),
    ...(getThinkingLevel ? { getThinkingLevel } : {}),
    ...(getClientSpoof ? { getClientSpoof } : {}),
    onSubagentEvent,
    onSubagentBatchEvent,
    onLocalToolRequest: async ({ runId, toolCallId, toolName, toolInput }) => {
      await handleLocalToolRequest(
        auth,
        runId,
        toolCallId,
        toolName,
        toolInput,
        yolo,
        {
          remoteTarget: getRemoteExecTarget(),
          sessionId: envOverride ?? sessionManager.getSessionId(),
        },
      );
    },
  });
}
