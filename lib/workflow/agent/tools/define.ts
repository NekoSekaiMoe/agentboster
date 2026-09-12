import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type {
  BuiltInToolId,
  ToolCatalogItem,
  ToolEntryConfig,
} from '@/types/config/tools';
import type { ChatSource, WorkflowUIMessageChunk } from '@/types/workflow';
import type { Tool, ToolSet } from 'ai';
import { hookRegistry } from '../hooks';
import type {
  AfterToolCallPayload,
  BeforeToolCallPayload,
  HookContext,
} from '../hooks';
import { getSecurityEngine } from '../security';
import type { SecurityCheckRequest } from '../security';
import {
  asToolTimeoutResult,
  resolveToolTimeoutMs,
  TOOL_TIMEOUT,
  withToolTimeout,
} from './timeout-guard';
import { isSpillExemptTool } from './spill/core';
import { withToolResultSpill } from './spill/wrap';

type MaybePromise<T> = T | Promise<T>;
type FactoryResult = Record<string, Tool | null> | null;
type BuildInToolResolution = {
  entry: ToolEntryConfig;
  mergedConfig: Record<string, string>;
  missingRequiredConfig: string[];
};

type BuildInToolDescriptor = {
  id: BuiltInToolId;
  description: string;
  requiredConfig: readonly string[];
  optionalConfig: readonly string[];
};

export type BuildInToolDefinition = BuildInToolDescriptor & {
  factory: (
    config: Record<string, string>,
    context: BuildInToolFactoryContext,
  ) => MaybePromise<FactoryResult>;
  toCatalogItem: (appConfig: AppConfig) => ToolCatalogItem;
  register: (
    appConfig: AppConfig,
    context: BuildInToolFactoryContext,
  ) => MaybePromise<ToolSet | null>;
};

export type BuildAgentToolsOptions = {
  runId?: string;
  agentName?: string;
  // true for parent-agent tool sets; false for nested sub-agent tool sets.
  allowDelegation?: boolean;
  writable?: WritableStream<WorkflowUIMessageChunk>;
  // The user initiating the session. Used by tools that persist
  // user-scoped data (e.g. writeMemory) so queries in the UI can find it.
  // Falls back to 'system' when unset (scheduled tasks, IM without userId).
  userId?: string;
  // The originating ChatSource. Tools gate on this to register source-
  // specific capabilities — e.g. local_* tools only register when
  // source.type === 'cli', because only the CLI host has the user's
  // filesystem. Undefined for legacy callers; tools must tolerate that.
  source?: ChatSource;
  // When true, drop every tool with side effects on the user's filesystem
  // or sandbox (write/edit/bash/local_*/sandbox/desktop/browser). Mirrors
  // pi's plan-mode extension: the model can read, search, and reason but
  // cannot mutate state until the user approves the proposed plan and the
  // CLI flips planMode to false for the next run. Read-only and reasoning
  // tools (read, local_read_file, memory read, sequential_thinking,
  // ask_question, sub-agent, schedule, task_summary, skills) stay
  // available so the model can investigate before proposing.
  planMode?: boolean;
  // Scheduled heartbeat wake-up (proactive-speak decision): the agent loop
  // forces toolChoice to heartbeat_decision at step 0 and gates output
  // delivery on the recorded decision. Also flags tool factory contexts
  // (heartbeat_decision only acknowledges inside heartbeat runs).
  heartbeat?: boolean;
  // Whether the per-workspace run lock was acquired for this run.
  // agentd-scoped execute tools (browser/desktop/sandbox) consult this to
  // decide whether to bind the long-lived workspace container: when false
  // (lock busy / unavailable / global session), they suppress
  // `workspace_id` so agentd uses a short-lived ephemeral container
  // instead of serializing on the workspace's ExecLockFor. Mirrors the
  // product contract "busy → fall back to ephemeral" that
  // acquireRunLockStep can't enforce alone. Optional here but defaults
  // to FALSE (fail-closed) inside buildAgentTools — never to true.
  workspaceLockAcquired?: boolean;
};

export type BuildInToolFactoryContext = {
  sessionId: string;
  runId: string;
  appConfig: AppConfig;
  agentName: string;
  // True when this run is a scheduled heartbeat wake-up (proactive-speak
  // decision). Tools key behavior off it — e.g. heartbeat_decision only
  // acknowledges inside heartbeat runs.
  heartbeat?: boolean;
  // Mirrors BuildAgentToolsOptions.allowDelegation.
  allowDelegation: boolean;
  // Mirrors BuildAgentToolsOptions.userId.
  userId?: string;
  // Mirrors BuildAgentToolsOptions.source.
  source?: ChatSource;
  writable?: WritableStream<WorkflowUIMessageChunk>;
  // Mirrors BuildAgentToolsOptions.workspaceLockAcquired. Always a
  // concrete boolean here — buildAgentTools resolves the optional input
  // with a fail-closed `?? false` before invoking factories.
  workspaceLockAcquired: boolean;
  buildNestedTools: (options?: BuildAgentToolsOptions) => Promise<ToolSet>;
};

const DEFAULT_TOOL_ENTRY_CONFIG: ToolEntryConfig = {
  enabled: true,
  config: {},
  minUserType: 'user',
};

const logger = createLogger('workflow.agent.tools.execute');

type ToolExecutionLogContext = {
  provider: 'builtin' | 'mcp';
  toolId: string;
  toolName: string;
  sessionId?: string;
  runId?: string;
  agentName?: string;
  serverName?: string;
};

function getArgKeys(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [];
  }

  return Object.keys(input).sort();
}

function getResultShape(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  if (error.cause instanceof Error) {
    return error.cause.message;
  }

  if (typeof error.cause === 'string') {
    return error.cause;
  }

  return undefined;
}

export interface ToolSecurityContext {
  sessionId: string;
  runId: string;
  agentName: string;
  appConfig: AppConfig;
}

function stringifyFull(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function readTextField(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '';
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

function firstTextField(value: unknown, keys: string[]): string {
  for (const key of keys) {
    const field = readTextField(value, key);
    if (field) {
      return field;
    }
  }
  return '';
}

function classifyWorkflowToolActivity(
  context: ToolExecutionLogContext,
  input: unknown,
): {
  action: 'read' | 'write' | 'execute' | 'search' | 'network' | 'other';
  target: string;
} {
  const toolName = context.toolName.toLowerCase();
  const toolId = context.toolId.toLowerCase();
  const combinedName = `${toolId}.${toolName}`;

  if (toolName.includes('read') || toolName.includes('list')) {
    return {
      action: 'read',
      target: firstTextField(input, ['path', 'name', 'query', 'key']),
    };
  }
  if (
    toolName.includes('write') ||
    toolName.includes('upsert') ||
    toolName.includes('update') ||
    toolName.includes('delete') ||
    toolName.includes('save')
  ) {
    return {
      action: 'write',
      target: firstTextField(input, ['path', 'name', 'key', 'title']),
    };
  }
  if (toolName.includes('search')) {
    return {
      action: 'search',
      target: firstTextField(input, ['query', 'q', 'pattern']),
    };
  }
  if (
    toolName.includes('exec') ||
    toolName.includes('command') ||
    combinedName.includes('sandbox')
  ) {
    return {
      action: 'execute',
      target: firstTextField(input, ['command', 'path', 'port']),
    };
  }
  if (toolName.includes('fetch') || toolName.includes('browser')) {
    return {
      action: 'network',
      target: firstTextField(input, ['url', 'query']),
    };
  }

  return {
    action: 'other',
    target: firstTextField(input, ['path', 'command', 'url', 'query', 'name']),
  };
}

function isAgentdBackedToolResult(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { backend?: unknown }).backend === 'agentd',
  );
}

async function writeWorkflowToolActivityLogStep(input: {
  sessionId: string;
  traceId?: string;
  agentId: string;
  toolCallId?: string;
  toolName: string;
  action: 'read' | 'write' | 'execute' | 'search' | 'network' | 'other';
  target: string;
  toolInput: unknown;
  result: unknown;
  outputText: string;
  success: boolean;
  error?: string;
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
}) {
  'use step';

  const { writeToolActivityLogs } = await import('@/lib/core/db/agentd');
  await writeToolActivityLogs([
    {
      sessionId: input.sessionId,
      traceId: input.traceId,
      agentId: input.agentId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      action: input.action,
      target: input.target,
      arguments: input.toolInput,
      result: input.result,
      outputText: input.outputText,
      success: input.success,
      error: input.error,
      durationMs: input.durationMs,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
  ]);
}

async function writeWorkflowToolActivityLog(input: {
  context: ToolExecutionLogContext;
  toolCallId?: string;
  toolInput: unknown;
  result?: unknown;
  error?: unknown;
  startedAt: Date;
  completedAt: Date;
  elapsedMs: number;
}) {
  if (!input.context.sessionId) {
    return;
  }

  const { action, target } = classifyWorkflowToolActivity(
    input.context,
    input.toolInput,
  );
  const errorMessage = input.error ? getErrorMessage(input.error) : undefined;
  const result =
    input.error instanceof Error
      ? {
          name: input.error.name,
          message: input.error.message,
          cause: getErrorCause(input.error),
        }
      : (input.error ?? input.result);

  try {
    await writeWorkflowToolActivityLogStep({
      sessionId: input.context.sessionId,
      traceId: input.context.runId,
      agentId: input.context.agentName ?? 'default',
      toolCallId: input.toolCallId,
      toolName: `${input.context.toolId}.${input.context.toolName}`,
      action,
      target,
      toolInput: input.toolInput,
      result,
      outputText: stringifyFull(result),
      success: !input.error,
      error: errorMessage,
      durationMs: input.elapsedMs,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    });
  } catch (error) {
    logger.warn('execute:activity_log_failed', {
      ...input.context,
      toolCallId: input.toolCallId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function withToolExecutionLogger(
  tool: ToolSet[string],
  context: ToolExecutionLogContext,
  securityContext?: ToolSecurityContext,
): ToolSet[string] {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }

  return {
    ...tool,
    execute: async (input, options) => {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs);
      const argKeys = getArgKeys(input);
      const toolCallId = options?.toolCallId;

      logger.info('execute:start', {
        ...context,
        argKeys,
        toolCallId,
      });

      // Security check (L0 rules engine)
      if (securityContext) {
        const engine = getSecurityEngine();
        const checkRequest: SecurityCheckRequest = {
          toolName: `${context.toolId}.${context.toolName}`,
          toolId: context.toolId,
          input: input as Record<string, unknown>,
          context: {
            sessionId: securityContext.sessionId,
            runId: securityContext.runId,
            agentName: securityContext.agentName,
            autonomyLevel:
              securityContext.appConfig.autonomy?.level ?? 'supervised',
            appConfig: securityContext.appConfig,
          },
        };
        const secResult = engine.check(checkRequest, securityContext.appConfig);
        if (secResult.decision === 'block') {
          logger.warn('tool:blocked_by_security', {
            toolId: context.toolId,
            toolName: context.toolName,
            ruleId: secResult.ruleId,
            reason: secResult.reason,
          });
          throw new Error(`Security blocked: ${secResult.reason}`);
        }
      }

      // beforeToolCall hook
      if (securityContext) {
        const hookCtx: HookContext = {
          sessionId: securityContext.sessionId,
          runId: securityContext.runId,
          agentName: securityContext.agentName,
          appConfig: securityContext.appConfig,
        };
        const beforePayload: BeforeToolCallPayload = {
          toolName: `${context.toolId}.${context.toolName}`,
          toolId: context.toolId,
          input: input as Record<string, unknown>,
        };
        await hookRegistry.executeBefore(
          'beforeToolCall',
          beforePayload,
          hookCtx,
        );
      }

      // Shared failure semantics (error log + onError hook + error activity
      // entry) for both thrown errors and structured timeout results.
      const recordFailure = async (error: unknown): Promise<void> => {
        const completedAt = new Date();
        const elapsedMs = completedAt.getTime() - startedAtMs;
        logger.error('execute:failed', {
          ...context,
          argKeys,
          toolCallId,
          elapsedMs,
          errorName: getErrorName(error),
          error: getErrorMessage(error),
          errorCause: getErrorCause(error),
        });

        // onError hook
        if (securityContext) {
          const hookCtx: HookContext = {
            sessionId: securityContext.sessionId,
            runId: securityContext.runId,
            agentName: securityContext.agentName,
            appConfig: securityContext.appConfig,
          };
          await hookRegistry.executeAfter(
            'onError',
            {
              error: error instanceof Error ? error : new Error(String(error)),
              phase: 'tool',
              context: {
                toolId: context.toolId,
                toolName: context.toolName,
              },
            },
            hookCtx,
          );
        }

        await writeWorkflowToolActivityLog({
          context,
          toolCallId,
          toolInput: input,
          error,
          startedAt,
          completedAt,
          elapsedMs,
        });
      };

      try {
        const result = await execute(input, options);

        const timeoutResult = asToolTimeoutResult(result);
        if (timeoutResult) {
          // The timeout guard resolves with a structured result instead of
          // throwing; route it through the same failure semantics while
          // still returning the result to the model. ONLY the timeout
          // guard's signature counts — ordinary `ok === false` results are
          // model-facing data, not tool failures.
          await recordFailure(
            Object.assign(
              new Error(
                `tool call timed out after ${timeoutResult.timeoutMs}ms`,
              ),
              { code: TOOL_TIMEOUT },
            ),
          );
          return result;
        }

        const completedAt = new Date();
        const elapsedMs = completedAt.getTime() - startedAtMs;

        logger.info('execute:success', {
          ...context,
          argKeys,
          toolCallId,
          elapsedMs,
          resultShape: getResultShape(result),
        });

        // afterToolCall hook
        if (securityContext) {
          const hookCtx: HookContext = {
            sessionId: securityContext.sessionId,
            runId: securityContext.runId,
            agentName: securityContext.agentName,
            appConfig: securityContext.appConfig,
          };
          const afterPayload: AfterToolCallPayload = {
            toolName: `${context.toolId}.${context.toolName}`,
            toolId: context.toolId,
            input: input as Record<string, unknown>,
            result,
            elapsedMs,
          };
          await hookRegistry.executeAfter(
            'afterToolCall',
            afterPayload,
            hookCtx,
          );
        }

        if (!isAgentdBackedToolResult(result)) {
          await writeWorkflowToolActivityLog({
            context,
            toolCallId,
            toolInput: input,
            result,
            startedAt,
            completedAt,
            elapsedMs,
          });
        }

        return result;
      } catch (error) {
        await recordFailure(error);
        throw error;
      }
    },
  };
}

function hasConfigValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getToolEntryConfig(
  appConfig: AppConfig,
  id: BuiltInToolId,
): ToolEntryConfig {
  return appConfig.tools?.[id] ?? DEFAULT_TOOL_ENTRY_CONFIG;
}

function resolveBuildInTool(
  appConfig: AppConfig,
  definition: BuildInToolDescriptor,
) {
  const entry = getToolEntryConfig(appConfig, definition.id);
  const mergedConfig = { ...entry.config };
  const configKeys = new Set([
    ...definition.requiredConfig,
    ...definition.optionalConfig,
  ]);

  for (const key of configKeys) {
    if (hasConfigValue(mergedConfig[key])) {
      continue;
    }

    const envValue = process.env[key];
    if (hasConfigValue(envValue)) {
      mergedConfig[key] = envValue;
    }
  }

  const missingRequiredConfig = definition.requiredConfig.filter(
    (key) => !hasConfigValue(mergedConfig[key]),
  );

  return {
    entry,
    mergedConfig,
    missingRequiredConfig,
  } satisfies BuildInToolResolution;
}

export function defineBuildInTool(config: {
  id: BuiltInToolId;
  description: string;
  requiredConfig?: readonly string[];
  optionalConfig?: readonly string[];
  factory: (
    config: Record<string, string>,
    context: BuildInToolFactoryContext,
  ) => MaybePromise<FactoryResult>;
}): BuildInToolDefinition {
  const {
    id,
    description,
    requiredConfig = [],
    optionalConfig = [],
    factory,
  } = config;

  const definition: BuildInToolDescriptor = {
    id,
    description,
    requiredConfig,
    optionalConfig,
  };

  return {
    ...definition,
    factory,
    toCatalogItem: (appConfig) => {
      const { entry, missingRequiredConfig } = resolveBuildInTool(
        appConfig,
        definition,
      );

      return {
        id,
        description,
        requiredConfig: [...requiredConfig],
        optionalConfig: [...optionalConfig],
        missingRequiredConfig,
        canEnable: missingRequiredConfig.length === 0,
        enabled: entry.enabled,
        config: entry.config,
      };
    },
    register: async (appConfig, context) => {
      const { entry, mergedConfig, missingRequiredConfig } = resolveBuildInTool(
        appConfig,
        definition,
      );

      if (!entry.enabled || missingRequiredConfig.length > 0) {
        return null;
      }

      const created = await factory(mergedConfig, context);
      if (!created) {
        return null;
      }

      const secCtx: ToolSecurityContext = {
        sessionId: context.sessionId,
        runId: context.runId,
        agentName: context.agentName,
        appConfig,
      };

      const toolTimeoutMs = resolveToolTimeoutMs(mergedConfig);
      const tools = Object.entries(created).reduce<ToolSet>(
        (allTools, entry) => {
          const [toolName, tool] = entry;
          if (tool) {
            // Timeout guard sits INSIDE the execution logger so the
            // activity log records the timeout result as the tool outcome.
            // Spill sits outside the timeout (dsh spill-policy is a
            // post-execute consumer: it observes the FINAL outcome; a
            // timed-out tool returns a small structured result and passes
            // through untouched). Spill retrieval itself is exempt
            // (isSpillExemptTool) so its pages can never re-spill, and
            // spilled records carry the session id for read-side
            // ownership checks.
            // Budget: tool entry config `timeoutMs` > env default; absent →
            // no deadline (delegated through unchanged).
            const guarded = withToolTimeout(tool, {
              timeoutMs: toolTimeoutMs,
            });
            allTools[toolName] = withToolExecutionLogger(
              isSpillExemptTool(toolName)
                ? guarded
                : withToolResultSpill(guarded, {
                    sessionId: context.sessionId,
                  }),
              {
                provider: 'builtin',
                toolId: id,
                toolName,
                sessionId: context.sessionId,
                runId: context.runId,
                agentName: context.agentName,
              },
              secCtx,
            );
          }

          return allTools;
        },
        {},
      );

      return Object.keys(tools).length > 0 ? tools : null;
    },
  };
}
