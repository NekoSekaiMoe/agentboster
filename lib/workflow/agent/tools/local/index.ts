import { tool } from 'ai';
import { z } from 'zod';
import { approvalHookBuilder, localToolResultHookBuilder } from '../../hooks';
import {
  writeLocalToolRequest,
  writeToolApprovalRequest,
  writeToolOutputDenied,
} from '../../sender/writers';
import { sendApprovalRequestReminderStep } from '../../sender/bot-steps';
import { defineBuildInTool } from '../define';
import { assessLocalToolRisk, shouldRequireApproval } from './security';

/**
 * Local-tool execution result returned by the CLI after running a
 * `local_*` tool against its own filesystem.
 */
export type LocalToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

type LocalToolApprovalResponse = {
  approved: boolean;
  reason?: string;
};

/**
 * Wait for L2 approval for a local tool execution. Mirrors the approval
 * flow in sanbox.ts (waitForSandboxApproval), but adapted for local tools.
 */
async function waitForLocalToolApproval(input: {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<LocalToolApprovalResponse> {
  await writeToolApprovalRequest({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });

  await sendApprovalRequestReminderStep({
    source: { type: 'web' },
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });

  using hook = approvalHookBuilder.create({ token: input.toolCallId });

  let approval: LocalToolApprovalResponse = { approved: false };
  for await (const payload of hook) {
    approval = payload;
    break;
  }

  if (!approval.approved) {
    await writeToolOutputDenied({
      toolCallId: input.toolCallId,
    });
  }

  return approval;
}

/**
 * Execute-body shared by all local_* tools. Emits a `local-tool-request`
 * status chunk to the SSE stream (CLI subscribes and reacts), then blocks
 * on localToolResultHookBuilder until the CLI POSTs the result to
 * /api/ai/[runId]/tool-result.
 *
 * Mirrors the approval flow (waitForSandboxApproval in
 * lib/workflow/agent/tools/execute/sanbox.ts), but **deliberately omits
 * the `'use step'` directive**. AGENTS.md documents that tool
 * `execute` callbacks already run on the host (marshalled via the
 * events channel), so anything they call is also host-side — wrapping
 * them as a workflow step makes the DevKit try to re-enter the vm and
 * `defineHook().create()` fails with "can only be called inside a
 * workflow function" because the step is dispatched outside the
 * workflow function's invocation context.
 *
 * When isRemoteControl is true, this function first assesses risk and requests
 * via the L2 approval flow before executing the tool on the CLI.
 *
 * Exported so that non-local-cli tools (specifically `runSkill` in
 * lib/workflow/agent/tools/skills/local.ts) can reuse the same CLI IPC
 * channel when the conversation is cli-sourced and the user has not
 * /switch-ed to agentd. The caller is responsible for generating a
 * unique `toolCallId` (e.g. `crypto.randomUUID()`) since it is not
 * coming from an ai-sdk tool-call frame in that case.
 */
export async function waitForLocalToolResult(input: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  sessionId?: string;
  runId?: string;
  isRemoteControl?: boolean;
  /**
   * Web-side YOLO (appConfig.autonomy.yolo). When true, the L2 approval
   * prompt for remote-control `local_*` invocations is skipped so the
   * behavior matches what the user configured globally. Hard `block`
   * risks still fire — block is the one wall YOLO won't breach, same as
   * it works for sandbox tools in security/engine.ts.
   */
  yolo?: boolean;
}): Promise<LocalToolResult> {
  // Risk-based approval for remote control mode. YOLO short-circuits the
  // escalation tier but keeps the hard block (mirrors security/engine.ts
  // effectiveActionLimit = 'block' when yolo is on).
  if (input.isRemoteControl && input.sessionId && input.runId) {
    const risk = assessLocalToolRisk(
      input.toolName,
      input.toolInput as Record<string, unknown>,
    );

    if (risk.level === 'block') {
      return {
        ok: false,
        error: `Tool execution blocked: ${risk.reason}`,
      };
    }

    if (!input.yolo && shouldRequireApproval(risk, true)) {
      const approvalResult = await waitForLocalToolApproval({
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolInput: input.toolInput,
      });

      if (!approvalResult.approved) {
        return {
          ok: false,
          error: `Tool execution denied by user: ${approvalResult.reason ?? 'no reason provided'}`,
        };
      }
    }
  }

  await writeLocalToolRequest({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });

  // Also push to the session-events SSE listener (for IM-triggered workflows
  // where the CLI is not consuming the workflow stream directly).
  if (input.sessionId) {
    try {
      const { pushToCliSession } = await import('@/lib/cli/remote-control');
      await pushToCliSession(input.sessionId, 'tool-request', {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        runId: input.runId,
        sessionId: input.sessionId,
      });
    } catch {
      // best-effort — listener may not be connected
    }
  }

  using hook = localToolResultHookBuilder.create({
    token: input.toolCallId,
  });

  let result: LocalToolResult = {
    ok: false,
    error: 'No response received from CLI client (timeout or disconnect).',
  };
  for await (const payload of hook) {
    result = payload;
    break;
  }

  return result;
}

function formatToolResult(result: LocalToolResult): {
  content: Array<{ type: 'text'; text: string }>;
} {
  if (!result.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `Local tool execution failed: ${result.error ?? 'unknown error'}`,
        },
      ],
    };
  }

  const output =
    typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output ?? null, null, 2);

  return {
    content: [{ type: 'text', text: output }],
  };
}

export default defineBuildInTool({
  id: 'local-cli',
  description: `File and shell tools executed on the user's local machine via the agentboster CLI client. Only available when the session was started from the CLI (channel 'cli:<clientId>') or when a CLI is online in remote control mode. Useful for editing files the user can see locally but that are not on agentd (e.g. files on a developer's laptop). All operations are performed by the CLI process with the user's own permissions.`,
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source, sessionId, runId, appConfig }) => {
    // Gate: register for CLI-originated sessions, or for sessions where
    // a CLI is online in remote control mode (IM controlling a CLI session).
    let isRemoteControlMode = false;
    if (source?.type !== 'cli') {
      let cliOnline = false;
      if (sessionId) {
        try {
          const { isCliOnlineForSession } = await import(
            '@/lib/cli/remote-control'
          );
          cliOnline = await isCliOnlineForSession(sessionId);
          isRemoteControlMode = cliOnline;
        } catch {
          // module unavailable
        }
      }
      if (!cliOnline) return null;
    }

    const sid = sessionId;
    const rid = runId;
    const remoteControl = isRemoteControlMode;
    const yolo = appConfig.autonomy?.yolo === true;

    return {
      local_read_file: tool({
        title: 'Read file on local machine',
        description: `Read the contents of a file on the user's local machine (where the CLI is running). Paths are relative to the CLI's current working directory; absolute paths are also accepted. Use this when the user asks you to inspect or modify files that live on their laptop/workstation rather than on agentd.`,
        inputSchema: z.object({
          path: z
            .string()
            .min(1)
            .describe('Absolute or relative path on the local machine.'),
        }),
        execute: async (input, { toolCallId }) => {
          const result = await waitForLocalToolResult({
            toolCallId,
            toolName: 'local_read_file',
            toolInput: input,
            sessionId: sid,
            runId: rid,
            isRemoteControl: remoteControl,
            yolo,
          });
          return formatToolResult(result);
        },
      }),

      local_write_file: tool({
        title: 'Write file on local machine',
        description: `Write or overwrite a file on the user's local machine. Creates parent directories if needed. Use this to apply edits the user asked for on files visible to the CLI process.`,
        inputSchema: z.object({
          path: z
            .string()
            .min(1)
            .describe('Absolute or relative path on the local machine.'),
          content: z.string().describe('Full new content of the file.'),
        }),
        execute: async (input, { toolCallId }) => {
          const result = await waitForLocalToolResult({
            toolCallId,
            toolName: 'local_write_file',
            toolInput: input,
            sessionId: sid,
            runId: rid,
            isRemoteControl: remoteControl,
            yolo,
          });
          return formatToolResult(result);
        },
      }),

      local_exec: tool({
        title: 'Run shell command on local machine',
        description: `Execute a shell command on the user's local machine using the CLI process's shell. Use for git, npm, build tools, or any command-line operation the user would run in their terminal. The command runs with the user's permissions and environment.`,
        inputSchema: z.object({
          command: z.string().min(1).describe('Shell command to execute.'),
          cwd: z
            .string()
            .optional()
            .describe(
              'Working directory for the command. Defaults to the CLI process cwd.',
            ),
        }),
        execute: async (input, { toolCallId }) => {
          const result = await waitForLocalToolResult({
            toolCallId,
            toolName: 'local_exec',
            toolInput: input,
            sessionId: sid,
            runId: rid,
            isRemoteControl: remoteControl,
            yolo,
          });
          return formatToolResult(result);
        },
      }),

      local_grep: tool({
        title: 'Search file contents on local machine',
        description:
          "Search file contents on the user's local machine using ripgrep " +
          '(rg). Returns matching lines with file paths and line numbers, ' +
          'respects .gitignore. The CLI host auto-downloads rg on first ' +
          'use if missing. Use this when you need to find code, configs, ' +
          "or text patterns on the user's own filesystem rather than on " +
          'agentd.',
        inputSchema: z.object({
          pattern: z
            .string()
            .min(1)
            .describe('Search pattern (regex or literal string).'),
          path: z
            .string()
            .optional()
            .describe(
              'Directory or file to search (default: current directory).',
            ),
          glob: z
            .string()
            .optional()
            .describe(
              "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'.",
            ),
          ignoreCase: z
            .boolean()
            .optional()
            .describe('Case-insensitive search (default: false).'),
          literal: z
            .boolean()
            .optional()
            .describe(
              'Treat pattern as literal string instead of regex (default: false).',
            ),
          context: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Number of lines to show before and after each match (default: 0).',
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Maximum number of matches to return (default: 100).'),
        }),
        execute: async (input, { toolCallId }) => {
          const result = await waitForLocalToolResult({
            toolCallId,
            toolName: 'local_grep',
            toolInput: input,
            sessionId: sid,
            runId: rid,
            isRemoteControl: remoteControl,
            yolo,
          });
          return formatToolResult(result);
        },
      }),

      local_ask_question: tool({
        title: 'Ask the user a question (local TUI)',
        description:
          'Ask the user a clarifying question. The CLI renders an inline ' +
          'prompt in the TUI and blocks until the user answers. Use ' +
          'sparingly — prefer acting on reasonable assumptions over ' +
          'interrupting the user. Each prompt can be free-text or ' +
          'multiple-choice (provide options).',
        inputSchema: z.object({
          prompts: z
            .array(
              z.object({
                question: z.string().min(1).describe('The question text.'),
                options: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'If provided, the user picks from these options. ' +
                      'Omit for free-text input.',
                  ),
                multiple: z
                  .boolean()
                  .optional()
                  .describe('If true with options, allow multiple selections.'),
              }),
            )
            .min(1)
            .max(5)
            .describe('1-5 questions to ask the user.'),
        }),
        execute: async (input, { toolCallId }) => {
          const result = await waitForLocalToolResult({
            toolCallId,
            toolName: 'local_ask_question',
            toolInput: input,
            sessionId: sid,
            runId: rid,
            isRemoteControl: false,
            yolo,
          });
          return formatToolResult(result);
        },
      }),
    };
  },
});
