/**
 * Local tool executor for remote control mode.
 * Executes local_* tools on the CLI's filesystem and computer-use tools via MCP.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  evaluateLocalCommand,
  formatToolRequest,
  type AgentbosterAuth,
} from '@agentboster/adapter';
import { createLogger } from '../../utils/logger.ts';
import { callMcpMethod, isMcpServerRunning } from './mcp-client.ts';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = createLogger('tool-executor');

/**
 * Tools that mutate the local filesystem or spawn a shell. These must
 * pass the L0/L1/L2 security gate before we run them; remote-control
 * mode has no TTY so any L2-confirm is fail-closed (rejected).
 */
const SECURITY_SENSITIVE_TOOLS = new Set(['local_write_file', 'local_exec']);

interface LocalReadFileInput {
  path: string;
}

interface LocalWriteFileInput {
  path: string;
  content: string;
}

interface LocalExecInput {
  command: string;
  cwd?: string;
}

interface LocalGrepInput {
  pattern: string;
  path?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  cwd?: string;
}

/**
 * Execute a local_* tool and return its output.
 *
 * Security: write/exec tools are routed through `evaluateLocalCommand`
 * (L0 + L1 + L2) before execution. If the gate says L2-confirm is
 * required and no approval channel is supplied, the request is rejected
 * fail-closed. Pass `auth` to enable L1 web scoring; pass `approver`
 * to handle L2-confirm prompts out-of-band (e.g. Desktop UI).
 */
export async function executeLocalTool(
  toolName: string,
  toolInput: unknown,
  options?: {
    auth?: AgentbosterAuth | null;
    approver?: (decision: {
      level: string;
      message: string;
      command: string;
    }) => Promise<boolean>;
    /**
     * Optional cancellation signal. When aborted, in-flight tools
     * should reject with an AbortError promptly. Used by
     * remote-control-mode so SIGTERM/SIGINT/SIGHUP can actually
     * interrupt a long-running local_exec instead of being held
     * hostage until the tool's own timeout expires.
     */
    signal?: AbortSignal;
  },
): Promise<unknown> {
  logger.info('Executing tool', { toolName });

  // Check up-front so a signal that fired before we got here fails
  // immediately rather than running the tool.
  options?.signal?.throwIfAborted();

  if (SECURITY_SENSITIVE_TOOLS.has(toolName)) {
    const command =
      toolName === 'local_exec'
        ? String((toolInput as { command?: unknown } | null)?.command ?? '')
        : formatToolRequest(toolName, toolInput);
    const decision = await evaluateLocalCommand(
      command,
      options?.auth ?? undefined,
    );
    if (!decision.ok) {
      throw new SecurityDenialError(`Security blocked: ${decision.message}`);
    }
    if (!decision.autoApprove) {
      const approved = options?.approver
        ? await options.approver({
            level: decision.level,
            message: decision.message,
            command,
          })
        : false;
      if (!approved) {
        throw new SecurityDenialError(
          `Requires confirmation (no approver available): ${decision.message}`,
        );
      }
    }
    // Re-check after the (possibly slow) approval call.
    options?.signal?.throwIfAborted();
  }

  switch (toolName) {
    case 'local_read_file':
      return executeLocalReadFile(
        toolInput as LocalReadFileInput,
        options?.signal,
      );
    case 'local_write_file':
      return executeLocalWriteFile(
        toolInput as LocalWriteFileInput,
        options?.signal,
      );
    case 'local_exec':
      return executeLocalExec(toolInput as LocalExecInput, options?.signal);
    case 'local_grep':
      return executeLocalGrep(toolInput as LocalGrepInput, options?.signal);

    // Computer-use tools via MCP
    case 'screenshot':
    case 'mouse_move':
    case 'mouse_click':
    case 'mouse_drag':
    case 'key_event':
    case 'type_text':
    case 'get_accessibility_tree':
    case 'get_focused_element':
      return executeComputerUseTool(toolName, toolInput, options?.signal);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function executeLocalReadFile(
  input: LocalReadFileInput,
  signal?: AbortSignal,
): Promise<string> {
  // fs.promises.readFile accepts an AbortSignal; rejects with AbortError
  // when the signal fires.
  const content = await readFile(input.path, { encoding: 'utf-8', signal });
  return content;
}

async function executeLocalWriteFile(
  input: LocalWriteFileInput,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, input.content, { encoding: 'utf-8', signal });
  return `File written: ${input.path}`;
}

async function executeLocalExec(
  input: LocalExecInput,
  signal?: AbortSignal,
): Promise<string> {
  // `exec` honors `signal` by killing the child with SIGTERM when the
  // signal aborts, and rejects the promise with an AbortError. This is
  // the main reason we plumb the signal down here: a runaway shell
  // command would otherwise hold the process hostage for its full
  // 5-minute timeout even after SIGTERM.
  const { stdout, stderr } = await execAsync(input.command, {
    cwd: input.cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 300000, // 5 minutes
    signal,
  });

  if (stderr) {
    return `${stdout}\n[stderr]\n${stderr}`;
  }
  return stdout;
}

async function executeLocalGrep(
  input: LocalGrepInput,
  signal?: AbortSignal,
): Promise<string> {
  // Build ripgrep command
  const args: string[] = ['rg', '--line-number', '--heading', '--color=never'];

  if (!input.caseSensitive) {
    args.push('--ignore-case');
  }

  if (!input.regex) {
    args.push('--fixed-strings');
  }

  if (input.filePattern) {
    args.push('--glob', input.filePattern);
  }

  args.push('--', input.pattern);

  if (input.path) {
    args.push(input.path);
  } else {
    args.push('.');
  }

  const { stdout, stderr } = await execFileAsync('rg', args.slice(1), {
    cwd: input.cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
    signal,
  });

  if (stderr && !stdout) {
    throw new Error(`ripgrep error: ${stderr}`);
  }

  return stdout || 'No matches found';
}

/**
 * Execute a computer-use tool via the MCP server.
 */
async function executeComputerUseTool(
  toolName: string,
  toolInput: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isMcpServerRunning()) {
    throw new Error(
      'MCP server is not running. Computer-use tools are unavailable.',
    );
  }

  logger.info('Forwarding to MCP', { toolName });

  // Call the MCP server via JSON-RPC. Abort before the call if the
  // signal has fired; callMcpMethod itself doesn't accept a signal,
  // but the check at least prevents *new* MCP calls during shutdown.
  signal?.throwIfAborted();
  const result = await callMcpMethod('tools/call', {
    name: toolName,
    arguments: toolInput,
  });

  // MCP returns { content: [...] } format
  // Extract the actual result
  if (result && typeof result === 'object' && 'content' in result) {
    return result;
  }

  return result;
}

/**
 * Raised when the security gate (L0 block / L1 critical / unreached L2)
 * refuses to let a tool call through. Callers should surface this as a
 * structured tool-result error, not a generic exception.
 */
export class SecurityDenialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityDenialError';
  }
}
