/**
 * Local tool executor for remote control mode.
 * Executes local_* tools on the CLI's filesystem and computer-use tools via MCP.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../utils/logger.ts';
import { callMcpMethod, isMcpServerRunning } from './mcp-client.ts';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = createLogger('tool-executor');

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
 */
export async function executeLocalTool(
  toolName: string,
  toolInput: unknown,
): Promise<unknown> {
  logger.info('Executing tool', { toolName });

  switch (toolName) {
    case 'local_read_file':
      return executeLocalReadFile(toolInput as LocalReadFileInput);
    case 'local_write_file':
      return executeLocalWriteFile(toolInput as LocalWriteFileInput);
    case 'local_exec':
      return executeLocalExec(toolInput as LocalExecInput);
    case 'local_grep':
      return executeLocalGrep(toolInput as LocalGrepInput);

    // Computer-use tools via MCP
    case 'screenshot':
    case 'mouse_move':
    case 'mouse_click':
    case 'mouse_drag':
    case 'key_event':
    case 'type_text':
    case 'get_accessibility_tree':
    case 'get_focused_element':
      return executeComputerUseTool(toolName, toolInput);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function executeLocalReadFile(
  input: LocalReadFileInput,
): Promise<string> {
  const content = await readFile(input.path, 'utf-8');
  return content;
}

async function executeLocalWriteFile(
  input: LocalWriteFileInput,
): Promise<string> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, input.content, 'utf-8');
  return `File written: ${input.path}`;
}

async function executeLocalExec(input: LocalExecInput): Promise<string> {
  const { stdout, stderr } = await execAsync(input.command, {
    cwd: input.cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 300000, // 5 minutes
  });

  if (stderr) {
    return `${stdout}\n[stderr]\n${stderr}`;
  }
  return stdout;
}

async function executeLocalGrep(input: LocalGrepInput): Promise<string> {
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
): Promise<unknown> {
  if (!isMcpServerRunning()) {
    throw new Error('MCP server is not running. Computer-use tools are unavailable.');
  }

  logger.info('Forwarding to MCP', { toolName });

  // Call the MCP server via JSON-RPC
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
