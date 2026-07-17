/**
 * MCP client for computer-use tools.
 * Spawns and manages the computer-use-mcp binary as a subprocess.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('mcp-client');

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

let mcpProcess: ChildProcess | null = null;
let requestId = 0;
const pendingRequests = new Map<
  number | string,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Start the MCP server process.
 * The binary is expected to be in the same directory as the CLI binary.
 */
export async function startMcpServer(sessionId: string): Promise<void> {
  if (mcpProcess) {
    logger.warn('MCP server already running');
    return;
  }

  // Find the MCP binary relative to the CLI binary
  const mcpBinaryPath = findMcpBinary();
  if (!mcpBinaryPath) {
    throw new Error('computer-use-mcp binary not found');
  }

  logger.info('Starting MCP server', { path: mcpBinaryPath });

  mcpProcess = spawn(mcpBinaryPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME ?? '',
      PATH: '',
      DISPLAY: process.env.DISPLAY ?? '',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      COMPUTER_USE_SESSION_ID: sessionId,
      COMPUTER_USE_CONFIG_DIR: process.env.CONFIG_DIR ?? '',
    },
  });

  let buffer = '';

  mcpProcess.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response: JsonRpcResponse = JSON.parse(line);
          const pending = pendingRequests.get(response.id);
          if (pending) {
            pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(`MCP error: ${response.error.message}`));
            } else {
              pending.resolve(response.result);
            }
          }
        } catch (error) {
          logger.error('Failed to parse MCP response', { line, error });
        }
      }
    }
  });

  mcpProcess.stderr?.on('data', (chunk: Buffer) => {
    logger.warn('MCP stderr', { output: chunk.toString() });
  });

  mcpProcess.on('error', (error) => {
    logger.error('MCP process error', { error });
    mcpProcess = null;
  });

  mcpProcess.on('exit', (code, signal) => {
    logger.info('MCP process exited', { code, signal });
    mcpProcess = null;
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('MCP process exited'));
      pendingRequests.delete(id);
    }
  });

  // Initialize the MCP server
  try {
    await callMcpMethod('initialize', {
      protocolVersion: '2024-11-05',
    });
  } catch (error) {
    await stopMcpServer();
    throw error;
  }

  logger.info('MCP server started');
}

/**
 * Stop the MCP server process.
 */
export async function stopMcpServer(): Promise<void> {
  if (!mcpProcess) {
    return;
  }

  logger.info('Stopping MCP server');
  mcpProcess.kill('SIGTERM');

  // Wait up to 5 seconds for graceful shutdown
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (mcpProcess) {
        mcpProcess.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    mcpProcess!.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  mcpProcess = null;
}

/**
 * Call an MCP method and return the result.
 */
export async function callMcpMethod(
  method: string,
  params?: unknown,
): Promise<unknown> {
  if (!mcpProcess) {
    throw new Error('MCP server not running');
  }

  const id = ++requestId;
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    const line = `${JSON.stringify(request)}\n`;
    mcpProcess!.stdin?.write(line, (error) => {
      if (error) {
        pendingRequests.delete(id);
        reject(error);
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('MCP request timeout'));
      }
    }, 30000);
  });
}

/**
 * Check if the MCP server is running.
 */
export function isMcpServerRunning(): boolean {
  return mcpProcess !== null;
}

/**
 * Find the computer-use-mcp binary.
 * Looks in the same directory as the CLI binary.
 */
function findMcpBinary(): string | null {
  // Desktop passes the MCP binary path via env
  if (process.env.COMPUTER_USE_MCP_PATH) {
    if (existsSync(process.env.COMPUTER_USE_MCP_PATH)) {
      return process.env.COMPUTER_USE_MCP_PATH;
    }
  }

  const possiblePaths = [
    // Production: same directory as the CLI binary
    join(process.execPath, '..', 'computer-use-mcp'),
    join(process.execPath, '..', 'computer-use-mcp.exe'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}
