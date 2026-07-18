/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from 'node:crypto';
import type { AgentSessionRuntime } from '../../core/agent-session-runtime.ts';
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  WorkingIndicatorOptions,
} from '../../core/extensions/index.ts';
import {
  flushRawStdout,
  takeOverStdout,
  waitForRawStdoutBackpressure,
  writeRawStdout,
} from '../../core/output-guard.ts';
import { McpServiceManager } from '../../core/mcp-services.ts';
import { killTrackedDetachedChildren } from '../../utils/shell.ts';
import { type Theme, theme } from '../interactive/theme/theme.ts';
import { attachJsonlLineReader, serializeJsonLine } from './jsonl.ts';
import {
  startCliSessionRegistrar,
  connectSessionEventStream,
  type RegistrarHandle,
  type SessionEventStreamHandle,
} from '../../core/cli-session-registrar.ts';
import { detectLocalCapabilities } from '../../core/capability-detect.ts';
import { getStoredAuth } from '@agentboster/adapter';
import { createLogger } from '../../utils/logger.ts';
import { startMcpServer, stopMcpServer } from '../remote-control/mcp-client.ts';
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from './rpc-types.ts';

// Re-export types for consumers
export type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from './rpc-types.ts';

const rpcLogger = createLogger('rpc-mode');

// Web session registrar + SSE listener handles. Populated only when
// RPC mode is launched with --backend-url + --web-session-id. Stopped on
// shutdown to release the KV online state promptly. RPC mode is
// single-instance per process so module-level state is safe.
let registrarHandle: RegistrarHandle | null = null;
let sessionStreamHandle: SessionEventStreamHandle | null = null;

export interface RpcModeOptions {
  /**
   * If set together with `sessionId`, RPC mode will register itself with
   * the Web backend as an online CLI session and listen for incoming
   * tool-request events on the session-events SSE stream.
   *
   * This lets Web-side providers (e.g. `computer-use-remote`) dispatch
   * computer-use tool calls to a CLI that Desktop spawned. Without this,
   * Desktop-launched RPC CLIs are invisible to the Web's remote tool
   * dispatch even though the MCP binary is loaded.
   */
  backendUrl?: string;
  sessionId?: string;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
  runtimeHost: AgentSessionRuntime,
  options: RpcModeOptions = {},
): Promise<never> {
  takeOverStdout();
  let session = runtimeHost.session;
  const mcpServices = new McpServiceManager();
  let unsubscribe: (() => void) | undefined;
  let unsubscribeBackpressure: (() => void) | undefined;

  const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
    writeRawStdout(serializeJsonLine(obj));
  };

  const success = <T extends RpcCommand['type']>(
    id: string | undefined,
    command: T,
    data?: object | null,
  ): RpcResponse => {
    if (data === undefined) {
      return { id, type: 'response', command, success: true } as RpcResponse;
    }
    return {
      id,
      type: 'response',
      command,
      success: true,
      data,
    } as RpcResponse;
  };

  const error = (
    id: string | undefined,
    command: string,
    message: string,
  ): RpcResponse => {
    return { id, type: 'response', command, success: false, error: message };
  };

  // Pending extension UI requests waiting for response
  const pendingExtensionRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  // Shutdown request flag
  let shutdownRequested = false;
  let shuttingDown = false;
  const signalCleanupHandlers: Array<() => unknown> = [];

  /** Helper for dialog methods with signal/timeout support */
  function createDialogPromise<T>(
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    request: Record<string, unknown>,
    parseResponse: (response: RpcExtensionUIResponse) => T,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener('abort', onAbort);
        pendingExtensionRequests.delete(id);
      };

      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });

      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }

      pendingExtensionRequests.set(id, {
        resolve: (response: RpcExtensionUIResponse) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject,
      });
      output({
        type: 'extension_ui_request',
        id,
        ...request,
      } as RpcExtensionUIRequest);
    });
  }

  /**
   * Create an extension UI context that uses the RPC protocol.
   */
  const createExtensionUIContext = (): ExtensionUIContext => ({
    select: (title, options, opts) =>
      createDialogPromise(
        opts,
        undefined,
        { method: 'select', title, options, timeout: opts?.timeout },
        (r) =>
          'cancelled' in r && r.cancelled
            ? undefined
            : 'value' in r
              ? r.value
              : undefined,
      ),

    confirm: (title, message, opts) =>
      createDialogPromise(
        opts,
        false,
        { method: 'confirm', title, message, timeout: opts?.timeout },
        (r) =>
          'cancelled' in r && r.cancelled
            ? false
            : 'confirmed' in r
              ? r.confirmed
              : false,
      ),

    input: (title, placeholder, opts) =>
      createDialogPromise(
        opts,
        undefined,
        { method: 'input', title, placeholder, timeout: opts?.timeout },
        (r) =>
          'cancelled' in r && r.cancelled
            ? undefined
            : 'value' in r
              ? r.value
              : undefined,
      ),

    notify(message: string, type?: 'info' | 'warning' | 'error'): void {
      // Fire and forget - no response needed
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'notify',
        message,
        notifyType: type,
      } as RpcExtensionUIRequest);
    },

    onTerminalInput(): () => void {
      // Raw terminal input not supported in RPC mode
      return () => {};
    },

    setStatus(key: string, text: string | undefined): void {
      // Fire and forget - no response needed
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setStatus',
        statusKey: key,
        statusText: text,
      } as RpcExtensionUIRequest);
    },

    setWorkingMessage(_message?: string): void {
      // Working message not supported in RPC mode - requires TUI loader access
    },

    setWorkingVisible(_visible: boolean): void {
      // Working visibility not supported in RPC mode - requires TUI loader access
    },

    setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
      // Working indicator customization not supported in RPC mode - requires TUI loader access
    },

    setHiddenThinkingLabel(_label?: string): void {
      // Hidden thinking label not supported in RPC mode - requires TUI message rendering access
    },

    setWidget(
      key: string,
      content: unknown,
      options?: ExtensionWidgetOptions,
    ): void {
      // Only support string arrays in RPC mode - factory functions are ignored
      if (content === undefined || Array.isArray(content)) {
        output({
          type: 'extension_ui_request',
          id: crypto.randomUUID(),
          method: 'setWidget',
          widgetKey: key,
          widgetLines: content as string[] | undefined,
          widgetPlacement: options?.placement,
        } as RpcExtensionUIRequest);
      }
      // Component factories are not supported in RPC mode - would need TUI access
    },

    setFooter(_factory: unknown): void {
      // Custom footer not supported in RPC mode - requires TUI access
    },

    setHeader(_factory: unknown): void {
      // Custom header not supported in RPC mode - requires TUI access
    },

    setTitle(title: string): void {
      // Fire and forget - host can implement terminal title control
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setTitle',
        title,
      } as RpcExtensionUIRequest);
    },

    async custom() {
      // Custom UI not supported in RPC mode
      return undefined as never;
    },

    pasteToEditor(text: string): void {
      // Paste handling not supported in RPC mode - falls back to setEditorText
      this.setEditorText(text);
    },

    setEditorText(text: string): void {
      // Fire and forget - host can implement editor control
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'set_editor_text',
        text,
      } as RpcExtensionUIRequest);
    },

    getEditorText(): string {
      // Synchronous method can't wait for RPC response
      // Host should track editor state locally if needed
      return '';
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pendingExtensionRequests.set(id, {
          resolve: (response: RpcExtensionUIResponse) => {
            if ('cancelled' in response && response.cancelled) {
              resolve(undefined);
            } else if ('value' in response) {
              resolve(response.value);
            } else {
              resolve(undefined);
            }
          },
          reject,
        });
        output({
          type: 'extension_ui_request',
          id,
          method: 'editor',
          title,
          prefill,
        } as RpcExtensionUIRequest);
      });
    },

    addAutocompleteProvider(): void {
      // Autocomplete provider composition is not supported in RPC mode
    },

    setEditorComponent(): void {
      // Custom editor components not supported in RPC mode
    },

    getEditorComponent() {
      // Custom editor components not supported in RPC mode
      return undefined;
    },

    get theme() {
      return theme;
    },

    getAllThemes() {
      return [];
    },

    getTheme(_name: string) {
      return undefined;
    },

    setTheme(_theme: string | Theme) {
      // Theme switching not supported in RPC mode
      return {
        success: false,
        error: 'Theme switching not supported in RPC mode',
      };
    },

    getToolsExpanded() {
      // Tool expansion not supported in RPC mode - no TUI
      return false;
    },

    setToolsExpanded(_expanded: boolean) {
      // Tool expansion not supported in RPC mode - no TUI
    },

    async computerUse(action, params) {
      // Route to the desktop host via the existing extension_ui_request
      // reverse-RPC channel. The desktop frontend handles method
      // 'computer_use' by invoking the matching Tauri command and
      // replying with the result (or an error).
      return createDialogPromise(
        undefined,
        undefined,
        { method: 'computer_use', action, params },
        (r) => {
          if ('cancelled' in r && r.cancelled) return undefined;
          if ('error' in r && r.error) {
            throw new Error(String(r.error));
          }
          // The desktop always serializes the Tauri result into `value`
          // as a JSON string; parse it back. For screenshot (binary), the
          // value is a base64 string and the caller handles decoding.
          if ('value' in r && typeof r.value === 'string') {
            try {
              return JSON.parse(r.value);
            } catch {
              return r.value;
            }
          }
          return undefined;
        },
      );
    },
  });

  runtimeHost.setRebindSession(async () => {
    await rebindSession();
  });

  const rebindSession = async (): Promise<void> => {
    session = runtimeHost.session;
    await session.bindExtensions({
      uiContext: createExtensionUIContext(),
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: async (options) => runtimeHost.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await runtimeHost.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          return runtimeHost.switchSession(sessionPath, options);
        },
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => {
        shutdownRequested = true;
      },
      onError: (err) => {
        output({
          type: 'extension_error',
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });

    unsubscribe?.();
    unsubscribeBackpressure?.();
    unsubscribe = session.subscribe((event) => {
      output(event);
    });
    unsubscribeBackpressure = session.agent.subscribe(async () => {
      await waitForRawStdoutBackpressure();
    });
  };

  const registerSignalHandlers = (): void => {
    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = () => {
        killTrackedDetachedChildren();
        void shutdown(signal === 'SIGHUP' ? 129 : 143, signal);
      };
      process.on(signal, handler);
      signalCleanupHandlers.push(() => process.off(signal, handler));
    }
  };

  await rebindSession();
  registerSignalHandlers();

  // Handle a single command
  const handleCommand = async (
    command: RpcCommand,
  ): Promise<RpcResponse | undefined> => {
    const id = command.id;

    switch (command.type) {
      // =================================================================
      // Prompting
      // =================================================================

      case 'prompt': {
        // Start prompt handling immediately, but emit the authoritative response only after
        // prompt preflight succeeds. Queued and immediately handled prompts also count as success.
        let preflightSucceeded = false;
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: 'rpc',
            preflightResult: (didSucceed) => {
              if (didSucceed) {
                preflightSucceeded = true;
                output(success(id, 'prompt'));
              }
            },
          })
          .catch((e) => {
            if (!preflightSucceeded) {
              output(error(id, 'prompt', e.message));
            }
          });
        return undefined;
      }

      case 'steer': {
        await session.steer(command.message, command.images);
        return success(id, 'steer');
      }

      case 'follow_up': {
        await session.followUp(command.message, command.images);
        return success(id, 'follow_up');
      }

      case 'abort': {
        await session.abort();
        return success(id, 'abort');
      }

      case 'new_session': {
        const options = command.parentSession
          ? { parentSession: command.parentSession }
          : undefined;
        const result = await runtimeHost.newSession(options);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'new_session', result);
      }

      // =================================================================
      // State
      // =================================================================

      case 'get_state': {
        const state: RpcSessionState = {
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          clientSpoof: session.settingsManager.getClientSpoof(),
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
        };
        return success(id, 'get_state', state);
      }

      // =================================================================
      // Model
      // =================================================================

      case 'set_model': {
        const models = await session.modelRegistry.getAvailable();
        const model = models.find(
          (m) => m.provider === command.provider && m.id === command.modelId,
        );
        if (!model) {
          return error(
            id,
            'set_model',
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        }
        await session.setModel(model);
        return success(id, 'set_model', model);
      }

      case 'cycle_model': {
        const result = await session.cycleModel();
        if (!result) {
          return success(id, 'cycle_model', null);
        }
        return success(id, 'cycle_model', result);
      }

      case 'get_available_models': {
        const models = await session.modelRegistry.getAvailable();
        return success(id, 'get_available_models', { models });
      }

      // =================================================================
      // Thinking
      // =================================================================

      case 'set_thinking_level': {
        session.setThinkingLevel(command.level);
        return success(id, 'set_thinking_level');
      }

      case 'cycle_thinking_level': {
        const level = session.cycleThinkingLevel();
        if (!level) {
          return success(id, 'cycle_thinking_level', null);
        }
        return success(id, 'cycle_thinking_level', { level });
      }

      // =================================================================
      // Queue Modes
      // =================================================================

      case 'set_steering_mode': {
        session.setSteeringMode(command.mode);
        return success(id, 'set_steering_mode');
      }

      case 'set_follow_up_mode': {
        session.setFollowUpMode(command.mode);
        return success(id, 'set_follow_up_mode');
      }

      case 'set_client_spoof': {
        session.settingsManager.setClientSpoof(command.clientSpoof);
        return success(id, 'set_client_spoof');
      }

      // =================================================================
      // Compaction
      // =================================================================

      case 'compact': {
        const result = await session.compact(command.customInstructions);
        return success(id, 'compact', result);
      }

      case 'set_auto_compaction': {
        session.setAutoCompactionEnabled(command.enabled);
        return success(id, 'set_auto_compaction');
      }

      // =================================================================
      // Retry
      // =================================================================

      case 'set_auto_retry': {
        session.setAutoRetryEnabled(command.enabled);
        return success(id, 'set_auto_retry');
      }

      case 'abort_retry': {
        session.abortRetry();
        return success(id, 'abort_retry');
      }

      // =================================================================
      // Bash
      // =================================================================

      case 'bash': {
        const result = await session.executeBash(command.command, undefined, {
          excludeFromContext: command.excludeFromContext,
        });
        return success(id, 'bash', result);
      }

      case 'abort_bash': {
        session.abortBash();
        return success(id, 'abort_bash');
      }

      // =================================================================
      // MCP/LSP services
      // =================================================================

      case 'mcp_discover': {
        const services = await mcpServices.discover({
          cwd: session.sessionManager.getCwd(),
        });
        return success(id, 'mcp_discover', { services });
      }

      case 'mcp_start': {
        const service = await mcpServices.start(command.service, {
          cwd: session.sessionManager.getCwd(),
        });
        return success(id, 'mcp_start', { service });
      }

      case 'mcp_stop': {
        const service = await mcpServices.stop(command.service);
        return success(id, 'mcp_stop', { service });
      }

      case 'mcp_list_running': {
        return success(id, 'mcp_list_running', {
          services: mcpServices.listRunning(),
        });
      }

      // =================================================================
      // Session
      // =================================================================

      case 'get_session_stats': {
        const stats = session.getSessionStats();
        return success(id, 'get_session_stats', stats);
      }

      case 'export_html': {
        const path = await session.exportToHtml(command.outputPath);
        return success(id, 'export_html', { path });
      }

      case 'switch_session': {
        const result = await runtimeHost.switchSession(command.sessionPath);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'switch_session', result);
      }

      case 'fork': {
        const result = await runtimeHost.fork(command.entryId);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'fork', {
          text: result.selectedText,
          cancelled: result.cancelled,
        });
      }

      case 'clone': {
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) {
          return error(
            id,
            'clone',
            'Cannot clone session: no current entry selected',
          );
        }
        const result = await runtimeHost.fork(leafId, { position: 'at' });
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'clone', { cancelled: result.cancelled });
      }

      case 'get_fork_messages': {
        const messages = session.getUserMessagesForForking();
        return success(id, 'get_fork_messages', { messages });
      }

      case 'get_last_assistant_text': {
        const text = session.getLastAssistantText();
        return success(id, 'get_last_assistant_text', { text });
      }

      case 'set_session_name': {
        const name = command.name.trim();
        if (!name) {
          return error(id, 'set_session_name', 'Session name cannot be empty');
        }
        session.setSessionName(name);
        return success(id, 'set_session_name');
      }

      // =================================================================
      // Messages
      // =================================================================

      case 'get_messages': {
        return success(id, 'get_messages', { messages: session.messages });
      }

      // =================================================================
      // Commands (available for invocation via prompt)
      // =================================================================

      case 'get_commands': {
        const commands: RpcSlashCommand[] = [];

        for (const command of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: command.invocationName,
            description: command.description,
            source: 'extension',
            sourceInfo: command.sourceInfo,
          });
        }

        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: 'prompt',
            sourceInfo: template.sourceInfo,
          });
        }

        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: 'skill',
            sourceInfo: skill.sourceInfo,
          });
        }

        return success(id, 'get_commands', { commands });
      }

      default: {
        const unknownCommand = command as { type: string };
        return error(
          id,
          unknownCommand.type,
          `Unknown command: ${unknownCommand.type}`,
        );
      }
    }
  };

  /**
   * Check if shutdown was requested and perform shutdown if so.
   * Called after handling each command when waiting for the next command.
   */
  let detachInput = () => {};

  async function shutdown(
    exitCode = 0,
    signal?: NodeJS.Signals,
  ): Promise<never> {
    if (shuttingDown) {
      process.exit(exitCode);
    }
    shuttingDown = true;
    // Run cleanup handlers in parallel — they're independent and any
    // failure shouldn't block the rest (each handler is responsible for
    // its own error handling).
    await Promise.allSettled(
      signalCleanupHandlers.map((cleanup) => Promise.resolve(cleanup())),
    );
    if (sessionStreamHandle) {
      await sessionStreamHandle.stop();
    }
    if (registrarHandle) {
      await registrarHandle.stop();
    }
    unsubscribe?.();
    unsubscribeBackpressure?.();
    await mcpServices.stopAll();
    await runtimeHost.dispose();
    detachInput();
    process.stdin.pause();
    if (signal !== 'SIGTERM') {
      await flushRawStdout();
    }
    process.exit(exitCode);
  }

  async function checkShutdownRequested(): Promise<void> {
    if (!shutdownRequested) return;
    await shutdown();
  }

  const handleInputLine = async (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseError: unknown) {
      output(
        error(
          undefined,
          'parse',
          `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        ),
      );
      await waitForRawStdoutBackpressure();
      return;
    }

    // Handle extension UI responses
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'extension_ui_response'
    ) {
      const response = parsed as RpcExtensionUIResponse;
      const pending = pendingExtensionRequests.get(response.id);
      if (pending) {
        pendingExtensionRequests.delete(response.id);
        pending.resolve(response);
      }
      return;
    }

    const command = parsed as RpcCommand;
    try {
      const response = await handleCommand(command);
      if (response) {
        output(response);
        await waitForRawStdoutBackpressure();
      }
      await checkShutdownRequested();
    } catch (commandError: unknown) {
      output(
        error(
          command.id,
          command.type,
          commandError instanceof Error
            ? commandError.message
            : String(commandError),
        ),
      );
      await waitForRawStdoutBackpressure();
    }
  };

  const onInputEnd = () => {
    void shutdown();
  };
  process.stdin.on('end', onInputEnd);

  detachInput = (() => {
    const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
      void handleInputLine(line);
    });
    return () => {
      detachJsonl();
      process.stdin.off('end', onInputEnd);
    };
  })();

  // Optional Web backend registration. When Desktop (or another
  // embedder) passes --backend-url + --session-id, RPC mode also:
  //   1. Registers itself online for that session so Web-side tool
  //      providers like `computer-use-remote` can dispatch to it.
  //   2. Listens on the session-events SSE stream for incoming
  //      tool-request events from the Web LLM, executing them locally
  //      and POSTing the result back. This is what closes the loop
  //      "Desktop starts CLI -> remote LLM can call screenshot/etc."
  //
  // Without this, the MCP binary is loaded but invisible to the Web's
  // remote tool dispatch (silent capability gap).
  if (options.backendUrl && options.sessionId) {
    try {
      const bridgeCleanup = await startWebSessionBridge(
        options.backendUrl,
        options.sessionId,
      );
      if (bridgeCleanup) signalCleanupHandlers.push(bridgeCleanup);
    } catch (error) {
      rpcLogger.warn('Failed to start Web session bridge', { error });
    }
  }

  // Keep process alive forever
  return new Promise(() => {});
}

/**
 * Wire RPC mode into the Web backend for `sessionId`:
 *   - detect local capabilities (display + MCP binary)
 *   - start the MCP server if applicable (so computer-use tools actually work)
 *   - start the registrar (heartbeat + register)
 *   - connect the SSE stream so Web-dispatched tool-requests reach us
 *
 * On any failure we log and continue — RPC mode's primary stdio loop
 * still works; only the Web remote-control path is degraded.
 */
async function startWebSessionBridge(
  backendUrl: string,
  sessionId: string,
): Promise<(() => Promise<void>) | undefined> {
  const auth = getStoredAuth();
  if (!auth) {
    rpcLogger.warn(
      'Web session bridge disabled: not authenticated (run agentboster-cli login)',
    );
    return;
  }

  // Security: never send the stored Bearer token to an arbitrary host.
  // `backendUrl` comes from the CLI `--backend-url` flag (set by Desktop
  // or any other embedder). Force its origin to match `auth.url` — the
  // URL the user actually logged in to. Otherwise a malicious embedder
  // could exfiltrate the token by pointing --backend-url at their own
  // server. We compare the fully-normalized origin (protocol+host+port).
  const authOrigin = safeOrigin(auth.url);
  const backendOrigin = safeOrigin(backendUrl);
  if (!authOrigin || !backendOrigin || authOrigin !== backendOrigin) {
    rpcLogger.warn(
      'Web session bridge disabled: --backend-url origin does not match the logged-in auth URL',
      { backendUrl, authUrl: auth.url },
    );
    return;
  }

  const capabilities = detectLocalCapabilities();
  const tools: string[] = [
    'local_read_file',
    'local_write_file',
    'local_exec',
    'local_grep',
  ];

  // process.cwd() is the project path Desktop launched the CLI with
  // (spawn cwd), which is the most accurate "what project is this CLI
  // working on" signal we have at this layer.
  const cwd = process.cwd();

  // Transactional startup: each successful step records a rollback
  // action; if a later step fails, we run the rollbacks in reverse
  // order. Only when *every* step succeeds do we publish the handles
  // to the module-level vars that shutdown() drains. Otherwise a
  // partial start would leave the registrar advertising this CLI as
  // online with no SSE listener to serve tool-requests, plus a leaked
  // MCP child process.
  const rollbacks: Array<() => Promise<void>> = [];
  let localMcpStarted = false;
  let localRegistrar: RegistrarHandle | null = null;
  let localStream: SessionEventStreamHandle | null = null;

  try {
    if (capabilities.hasMcpBinary && capabilities.hasDisplay) {
      try {
        await startMcpServer(sessionId);
        localMcpStarted = true;
        rollbacks.push(async () => {
          try {
            await stopMcpServer();
          } catch (err) {
            rpcLogger.warn('Rollback: MCP stop failed', { error: err });
          }
        });
        tools.push(
          'screenshot',
          'mouse_move',
          'mouse_click',
          'mouse_drag',
          'key_event',
          'type_text',
          'get_accessibility_tree',
          'get_focused_element',
        );
      } catch (error) {
        // MCP failure is non-fatal: degrade capabilities and continue.
        // No rollback recorded because nothing was started.
        rpcLogger.warn(
          'MCP server failed to start; computer-use tools disabled',
          { error },
        );
      }
    }

    localRegistrar = await startCliSessionRegistrar({
      backendUrl,
      token: auth.token,
      sessionId,
      tools,
      capabilities,
      cwd,
    });
    rollbacks.push(async () => {
      try {
        await localRegistrar?.stop();
      } catch (err) {
        rpcLogger.warn('Rollback: registrar stop failed', { error: err });
      }
    });

    localStream = await connectSessionEventStream({
      backendUrl,
      token: auth.token,
      sessionId,
      onToolRequest: async (request) => {
        // Execute the tool locally and POST the result back. We reuse
        // remote-control-mode's executor since the tool set is identical.
        // Pass `auth` so write/exec tools go through the L0/L1/L2 gate.
        // RPC mode has no TTY/approver, so any L2-confirm is fail-closed.
        try {
          const { executeLocalTool } = await import(
            '../remote-control/tool-executor.ts'
          );
          const output = await executeLocalTool(
            request.toolName,
            request.toolInput,
            { auth },
          );
          await postToolResult(backendUrl, auth.token, sessionId, {
            toolCallId: request.toolCallId,
            ok: true,
            output,
          });
        } catch (error: unknown) {
          await postToolResult(backendUrl, auth.token, sessionId, {
            toolCallId: request.toolCallId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    rollbacks.push(async () => {
      try {
        await localStream?.stop();
      } catch (err) {
        rpcLogger.warn('Rollback: stream stop failed', { error: err });
      }
    });

    // All steps succeeded — publish to module-level handles so the
    // main shutdown() path can drain them.
    registrarHandle = localRegistrar;
    sessionStreamHandle = localStream;
  } catch (error) {
    rpcLogger.error(
      'Web session bridge startup failed; rolling back partially-started resources',
      { error },
    );
    while (rollbacks.length > 0) {
      const rb = rollbacks.pop();
      if (rb) await rb();
    }
    // Re-throw so the caller knows the bridge is unhealthy and can
    // skip registering a (meaningless) cleanup handler.
    throw error;
  }

  // Best-effort: stop the computer-use MCP child process on shutdown.
  // `mcpServices.stopAll()` only drains the interactive MCP services
  // spawned via McpServiceManager; the Web-bridge MCP server is tracked
  // separately by the remote-control module and needs its own call.
  // Return the cleanup to the caller so it can register it on its own
  // shutdown pipeline (this function doesn't have access to it).
  // Capture `localMcpStarted` in the closure; if MCP was never started
  // (or already stopped during a rollback), this is a no-op.
  const shouldStopMcp = localMcpStarted;
  return async () => {
    if (!shouldStopMcp) return;
    try {
      await stopMcpServer();
    } catch (error) {
      rpcLogger.warn('Failed to stop MCP server during shutdown', { error });
    }
  };
}

async function postToolResult(
  backendUrl: string,
  token: string,
  sessionId: string,
  result: {
    toolCallId: string;
    ok: boolean;
    output?: unknown;
    error?: string;
  },
): Promise<void> {
  // Bounded retry: 3 attempts with 500ms / 2s backoff. The receiver is
  // idempotent on `toolCallId`, so re-POSTing after a network blip is
  // safe. The previous "log and forget" behavior left local side
  // effects applied while the Web side timed out waiting for the
  // result — this narrows that window without unbounded blocking.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 500, 2_000];
  const REQUEST_TIMEOUT_MS = 8_000;
  const url = `${backendUrl}/api/cli/tool-result`;
  const body = JSON.stringify({
    sessionId,
    toolCallId: result.toolCallId,
    ok: result.ok,
    output: result.output,
    error: result.error,
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt]) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return;
      }
      // 4xx (except 429) — receiver rejected the payload; retrying
      // won't help. Surface the failure so the SSE handler can log
      // it (the toolCallId is now "lost" on the Web side).
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        rpcLogger.error('tool-result POST permanently rejected', {
          status: response.status,
          toolCallId: result.toolCallId,
        });
        return;
      }
      // 5xx / 429 / network error — try again.
      rpcLogger.warn('tool-result POST failed, retrying', {
        status: response.status,
        attempt,
        toolCallId: result.toolCallId,
      });
    } catch (error) {
      rpcLogger.warn('tool-result POST threw, retrying', {
        attempt,
        toolCallId: result.toolCallId,
        error,
      });
    }
  }
  // Exhausted. This is the unrecoverable case — surface it loudly.
  rpcLogger.error('tool-result POST exhausted retries', {
    toolCallId: result.toolCallId,
  });
}

/**
 * Normalize a URL down to its origin (protocol+host+port) for safe
 * same-origin comparison. Returns null if the URL is not parseable or
 * not an http(s) URL. Used to gate token-bearing requests so the stored
 * Bearer token can never be sent to an arbitrary host.
 */
function safeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
