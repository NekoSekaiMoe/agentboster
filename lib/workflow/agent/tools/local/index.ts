import { tool } from 'ai';
import { z } from 'zod';
import { localToolResultHookBuilder } from '../../hooks';
import { writeLocalToolRequest } from '../../sender/writers';
import { defineBuildInTool } from '../define';

/**
 * Local-tool execution result returned by the CLI after running a
 * `local_*` tool against its own filesystem.
 */
type LocalToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

/**
 * Execute-body shared by all local_* tools. Emits a `local-tool-request`
 * status chunk to the SSE stream (CLI subscribes and reacts), then blocks
 * on localToolResultHookBuilder until the CLI POSTs the result to
 * /api/ai/[runId]/tool-result.
 *
 * Mirrors the approval flow (waitForSandboxApproval in
 * lib/workflow/agent/tools/execute/sanbox.ts). All host-only work (the
 * chunk write and the hook iterator) is wrapped in `'use step'` so it
 * marshalls back to the host Node process inside the Workflow DevKit.
 */
async function waitForLocalToolResult(input: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<LocalToolResult> {
  'use step';

  await writeLocalToolRequest({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });

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
  description: `File and shell tools executed on the user's local machine via the agentboster CLI client. Only available when the session was started from the CLI (channel 'cli:<clientId>'). Useful for editing files the user can see locally but that are not on agentd (e.g. files on a developer's laptop). All operations are performed by the CLI process with the user's own permissions.`,
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source }) => {
    // Gate: only register for CLI-originated sessions. Web/IM/scheduled
    // sessions have no CLI peer connected and would block forever on the
    // localToolResultHookBuilder.
    if (source?.type !== 'cli') {
      return null;
    }

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
          });
          return formatToolResult(result);
        },
      }),
    };
  },
});
