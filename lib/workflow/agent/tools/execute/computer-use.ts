import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';
import { localToolResultHookBuilder } from '../../hooks';
import { writeLocalToolRequest } from '../../sender/writers';

/**
 * Computer-use tools (screenshot, mouse, keyboard, accessibility) executed
 * on the user's local machine via CLI remote control + MCP server.
 *
 * These tools are only available when:
 * 1. A CLI is online in remote control mode for this session
 * 2. The CLI has display capabilities (hasDisplay: true)
 *
 * The execute callbacks use the same dispatch mechanism as local_* tools:
 * writeLocalToolRequest → CLI receives via SSE → CLI forwards to MCP server
 * → MCP returns result → CLI POSTs back to /api/ai/[runId]/tool-result
 */

type LocalToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

async function dispatchToCliMcp(
  sessionId: string,
  runId: string,
  toolCallId: string,
  toolName: string,
  toolInput: unknown,
): Promise<{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
}> {
  // Dispatch via the same mechanism as local_* tools
  await writeLocalToolRequest({
    toolCallId,
    toolName,
    toolInput,
  });

  // Also push to session-events SSE
  try {
    const { pushToCliSession } = await import('@/lib/cli/remote-control');
    await pushToCliSession(sessionId, 'tool-request', {
      toolCallId,
      toolName,
      toolInput,
      runId,
      sessionId,
    });
  } catch {
    // best-effort
  }

  using hook = localToolResultHookBuilder.create({ token: toolCallId });

  let result: LocalToolResult = {
    ok: false,
    error: 'Timeout waiting for CLI MCP response',
  };
  for await (const payload of hook) {
    result = payload;
    break;
  }

  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `computer-use error: ${result.error}` }],
    };
  }

  // screenshot returns image content
  if (toolName === 'screenshot' && typeof result.output === 'object') {
    const output = result.output as any;
    if (output.content?.[0]?.type === 'image') {
      return { content: output.content };
    }
  }

  const text =
    typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output, null, 2);
  return { content: [{ type: 'text', text }] };
}

export default defineBuildInTool({
  id: 'computer-use-remote',
  description:
    "Computer-use tools (screenshot, mouse, keyboard, accessibility) on the user's local machine via CLI remote control. Only available when a CLI with display capabilities is online.",
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source, sessionId, runId }) => {
    if (!sessionId || !runId) return null;

    // Only register when CLI is online and has display capabilities
    try {
      const { getCliCapabilities } = await import('@/lib/cli/remote-control');
      const caps = await getCliCapabilities(sessionId);
      if (!caps?.online || !caps.capabilities.hasDisplay) {
        return null;
      }
    } catch {
      return null;
    }

    // Only for CLI sessions or remote-controlled sessions
    const isRemoteIm = source?.type === 'im' && source.remoteIm === true;
    if (source?.type !== 'cli' && !isRemoteIm) {
      return null;
    }

    const sid = sessionId;
    const rid = runId;

    return {
      screenshot: tool({
        description:
          'Capture the screen and return a scaled PNG image. Terminal windows are automatically excluded. All coordinates in the image match the scaled resolution.',
        inputSchema: z.object({
          max_width: z
            .number()
            .optional()
            .describe('Maximum width in pixels (default: 1400)'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'screenshot',
            input,
          );
        },
      }),

      mouse_move: tool({
        description:
          'Move the mouse cursor to the specified coordinates. Coordinates are in the screenshot coordinate space (scaled resolution).',
        inputSchema: z.object({
          x: z.number().describe('X coordinate (screenshot scale)'),
          y: z.number().describe('Y coordinate (screenshot scale)'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'mouse_move',
            input,
          );
        },
      }),

      mouse_click: tool({
        description:
          'Click at the specified coordinates. Coordinates are in the screenshot coordinate space.',
        inputSchema: z.object({
          x: z.number().describe('X coordinate (screenshot scale)'),
          y: z.number().describe('Y coordinate (screenshot scale)'),
          button: z
            .enum(['left', 'right', 'middle'])
            .optional()
            .default('left')
            .describe('Mouse button to click'),
          click_type: z
            .enum(['single', 'double'])
            .optional()
            .default('single')
            .describe('Single or double click'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'mouse_click',
            input,
          );
        },
      }),

      mouse_drag: tool({
        description:
          'Drag the mouse from one point to another. Coordinates are in the screenshot coordinate space.',
        inputSchema: z.object({
          from_x: z.number().describe('Start X coordinate'),
          from_y: z.number().describe('Start Y coordinate'),
          to_x: z.number().describe('End X coordinate'),
          to_y: z.number().describe('End Y coordinate'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'mouse_drag',
            input,
          );
        },
      }),

      key_event: tool({
        description:
          'Press a key or key combination. Use for shortcuts (e.g., "ctrl+s", "alt+tab") or special keys (e.g., "enter", "escape", "tab").',
        inputSchema: z.object({
          key: z
            .string()
            .describe(
              'Key name (e.g., "enter", "tab", "a", "F5", "escape", "backspace")',
            ),
          modifiers: z
            .array(z.string())
            .optional()
            .describe('Modifier keys: "ctrl", "alt", "shift", "meta"'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'key_event',
            input,
          );
        },
      }),

      type_text: tool({
        description:
          'Type a string of text as keyboard input. Use for entering text into focused input fields.',
        inputSchema: z.object({
          text: z.string().describe('Text to type'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'type_text',
            input,
          );
        },
      }),

      get_accessibility_tree: tool({
        description:
          'Get the UI accessibility tree. Returns a structured representation of UI elements with their roles, names, values, and bounding boxes. Useful for finding interactive elements programmatically.',
        inputSchema: z.object({
          app_name: z
            .string()
            .optional()
            .describe('Filter to a specific application name'),
          max_depth: z
            .number()
            .optional()
            .describe('Maximum tree depth to traverse (default: unlimited)'),
        }),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'get_accessibility_tree',
            input,
          );
        },
      }),

      get_focused_element: tool({
        description:
          'Get the currently focused UI element. Returns the element that would receive keyboard input.',
        inputSchema: z.object({}),
        execute: async (input: any, { toolCallId }: any) => {
          return await dispatchToCliMcp(
            sid,
            rid,
            toolCallId,
            'get_focused_element',
            input,
          );
        },
      }),
    };
  },
});
