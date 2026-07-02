/**
 * Computer-use tools: screenshots, mouse/keyboard input, and accessibility
 * tree reading.
 *
 * These tools are thin shims — they forward every call to the host desktop
 * app via {@link ExtensionUIContext.computerUse}. In TUI/print mode that
 * method rejects with a clear error, so the tools surface "computer use is
 * only available in the desktop app" instead of crashing.
 *
 * The host (desktop) owns the actual platform implementation (see
 * `src-tauri/src/computer_use.rs`); the CLI never touches xcap/enigo/AX
 * directly. This keeps the heavy native deps out of the CLI bundle and
 * lets the desktop gate computer use behind its own permission UI.
 */

import type { AgentTool } from '@agentboster-cli/agent';
import type { ImageContent, TextContent } from '@agentboster-cli/ai';
import { Text } from '@agentboster-cli/tui';
import { type Static, Type } from 'typebox';
import type { ToolDefinition } from '../extensions/types.ts';
import { wrapToolDefinition } from './tool-definition-wrapper.ts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const screenshotSchema = Type.Object({});

const mouseMoveSchema = Type.Object({
  x: Type.Integer({ description: 'Target absolute X coordinate (pixels)' }),
  y: Type.Integer({ description: 'Target absolute Y coordinate (pixels)' }),
});

const mouseClickSchema = Type.Object({
  button: Type.Optional(
    Type.String({
      description:
        'Mouse button: "left" (default), "right", "middle", "back", "forward"',
    }),
  ),
});

const mouseDragSchema = Type.Object({
  toX: Type.Integer({ description: 'Destination absolute X (pixels)' }),
  toY: Type.Integer({ description: 'Destination absolute Y (pixels)' }),
});

const keyEventSchema = Type.Object({
  key: Type.String({
    description:
      'Key name (Return, Tab, Space, Escape, Backspace, Delete, Home, End, PageUp, PageDown, Up, Down, Left, Right, Control, Shift, Alt, Meta, CapsLock, F1..F12, or a single Unicode character like "c" / "1" / "/").',
  }),
  direction: Type.String({
    description: '"press" | "release" | "click"',
  }),
});

const typeTextSchema = Type.Object({
  text: Type.String({ description: 'Arbitrary Unicode string to type' }),
});

const getAxAtPointSchema = Type.Object({
  x: Type.Integer({ description: 'Screen X coordinate (pixels)' }),
  y: Type.Integer({ description: 'Screen Y coordinate (pixels)' }),
  maxDepth: Type.Optional(
    Type.Integer({
      description: 'Max tree depth to return (default 3, capped at 5)',
    }),
  ),
});

const getFocusedAxSchema = Type.Object({
  maxDepth: Type.Optional(
    Type.Integer({
      description: 'Max tree depth to return (default 3, capped at 5)',
    }),
  ),
});

export type ScreenshotToolInput = Static<typeof screenshotSchema>;
export type MouseMoveToolInput = Static<typeof mouseMoveSchema>;
export type MouseClickToolInput = Static<typeof mouseClickSchema>;
export type MouseDragToolInput = Static<typeof mouseDragSchema>;
export type KeyEventToolInput = Static<typeof keyEventSchema>;
export type TypeTextToolInput = Static<typeof typeTextSchema>;
export type GetAxAtPointToolInput = Static<typeof getAxAtPointSchema>;
export type GetFocusedAxToolInput = Static<typeof getFocusedAxSchema>;

export interface ComputerUseToolDetails {
  action: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke the host's computer_use channel, returning a text content array
 * describing the outcome. Catches host errors (including TUI-mode rejects)
 * and surfaces them as tool text instead of throwing — the agent loop
 * treats a thrown tool error as a hard failure, which is wrong for a
 * best-effort platform capability.
 */
async function runAction(
  ctx:
    | {
        ui: {
          computerUse(
            action: string,
            params: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    | undefined,
  action: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!ctx?.ui?.computerUse) {
    return { ok: false, error: 'computer use host bridge is not available' };
  }
  try {
    const result = await ctx.ui.computerUse(action, params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function summarizeAxResult(result: unknown): string {
  if (result && typeof result === 'object') {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function createScreenshotToolDefinition(): ToolDefinition<
  typeof screenshotSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'screenshot',
    label: 'screenshot',
    description:
      'Capture the primary screen as a PNG image and return it as an image attachment. Use this to see what is currently on screen before clicking or typing. No arguments.',
    promptSnippet: 'Capture the screen',
    promptGuidelines: [
      'Use screenshot before any mouse_click / type_text / key_event call when you are not certain of the current UI state.',
    ],
    parameters: screenshotSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'screenshot', {});
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: `screenshot failed: ${res.error}` }],
          details: { action: 'screenshot' },
        };
      }
      // The desktop host returns { data: <base64 png>, mimeType: "image/png" }.
      const r = res.result as { data?: string; mimeType?: string } | undefined;
      if (r?.data && r.mimeType) {
        const content: (TextContent | ImageContent)[] = [
          { type: 'text', text: `Captured screen [${r.mimeType}]` },
          { type: 'image', data: r.data, mimeType: r.mimeType },
        ];
        return { content, details: { action: 'screenshot' } };
      }
      return {
        content: [
          {
            type: 'text',
            text: `screenshot returned an unexpected payload: ${summarizeAxResult(res.result)}`,
          },
        ],
        details: { action: 'screenshot' },
      };
    },
    renderResult(result, _options, _theme, _context) {
      const text = new Text('', 0, 0);
      const first = result.content[0];
      text.setText(
        first && first.type === 'text' ? first.text : '[screenshot]',
      );
      return text;
    },
  };
}

export function createMouseMoveToolDefinition(): ToolDefinition<
  typeof mouseMoveSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'mouse_move',
    label: 'mouse_move',
    description:
      'Move the mouse cursor to absolute screen coordinates (x, y) in pixels. Does not click.',
    promptSnippet: 'Move the mouse cursor',
    parameters: mouseMoveSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'mouse_move', {
        x: params.x,
        y: params.y,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Moved mouse to (${params.x}, ${params.y})`
              : `mouse_move failed: ${res.error}`,
          },
        ],
        details: { action: 'mouse_move' },
      };
    },
  };
}

export function createMouseClickToolDefinition(): ToolDefinition<
  typeof mouseClickSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'mouse_click',
    label: 'mouse_click',
    description:
      'Click a mouse button at the current cursor position. Use mouse_move first to position the cursor. Button defaults to "left"; also accepts "right", "middle", "back", "forward".',
    promptSnippet: 'Click the mouse',
    parameters: mouseClickSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const button = params.button ?? 'left';
      const res = await runAction(ctx, 'mouse_click', { button });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Clicked ${button} button`
              : `mouse_click failed: ${res.error}`,
          },
        ],
        details: { action: 'mouse_click' },
      };
    },
  };
}

export function createMouseDragToolDefinition(): ToolDefinition<
  typeof mouseDragSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'mouse_drag',
    label: 'mouse_drag',
    description:
      'Drag the mouse from the current cursor position to (toX, toY) while holding the left button. Use for drag-and-drop, selection, and slider gestures.',
    promptSnippet: 'Drag the mouse',
    parameters: mouseDragSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'mouse_drag', {
        toX: params.toX,
        toY: params.toY,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Dragged mouse to (${params.toX}, ${params.toY})`
              : `mouse_drag failed: ${res.error}`,
          },
        ],
        details: { action: 'mouse_drag' },
      };
    },
  };
}

export function createKeyEventToolDefinition(): ToolDefinition<
  typeof keyEventSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'key_event',
    label: 'key_event',
    description:
      'Press, release, or click a single key. Accepts key names like "Return", "Escape", "Tab", "Space", "Control", "Shift", "Alt", "Meta", "Up", "Down", "Left", "Right", "F1".."F12", or a single Unicode character like "c" / "1" / "/". For chords (e.g. Ctrl+C), issue separate calls: click Control, click "c".',
    promptSnippet: 'Press a key',
    parameters: keyEventSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'key_event', {
        key: params.key,
        direction: params.direction,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `${params.direction} ${params.key}`
              : `key_event failed: ${res.error}`,
          },
        ],
        details: { action: 'key_event' },
      };
    },
  };
}

export function createTypeTextToolDefinition(): ToolDefinition<
  typeof typeTextSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'type_text',
    label: 'type_text',
    description:
      'Type an arbitrary Unicode string at the current focus. Use this for text entry after clicking a field. For key combinations (modifiers + key), use key_event instead.',
    promptSnippet: 'Type text',
    parameters: typeTextSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'type_text', { text: params.text });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Typed ${params.text.length} character(s)`
              : `type_text failed: ${res.error}`,
          },
        ],
        details: { action: 'type_text' },
      };
    },
  };
}

export function createGetAxAtPointToolDefinition(): ToolDefinition<
  typeof getAxAtPointSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'get_ax_at_point',
    label: 'get_ax_at_point',
    description:
      'Read the accessibility (AX) tree rooted at the UI element under screen point (x, y), up to maxDepth levels deep (default 3, capped at 5). Returns a JSON tree of role/name/value/bounds/enabled/focused/children. Use this to inspect on-screen UI structure precisely (more reliable than OCR on screenshots).',
    promptSnippet: 'Read the AX tree at a point',
    parameters: getAxAtPointSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'get_ax_at_point', {
        x: params.x,
        y: params.y,
        maxDepth: params.maxDepth,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? summarizeAxResult(res.result)
              : `get_ax_at_point failed: ${res.error}`,
          },
        ],
        details: { action: 'get_ax_at_point' },
      };
    },
  };
}

export function createGetFocusedAxToolDefinition(): ToolDefinition<
  typeof getFocusedAxSchema,
  ComputerUseToolDetails
> {
  return {
    name: 'get_focused_ax',
    label: 'get_focused_ax',
    description:
      'Read the accessibility (AX) tree rooted at the currently focused UI element, up to maxDepth levels deep (default 3, capped at 5). Use this to inspect what input/control currently has keyboard focus.',
    promptSnippet: 'Read the focused AX tree',
    parameters: getFocusedAxSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await runAction(ctx, 'get_focused_ax', {
        maxDepth: params.maxDepth,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? summarizeAxResult(res.result)
              : `get_focused_ax failed: ${res.error}`,
          },
        ],
        details: { action: 'get_focused_ax' },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory wrappers (return AgentTool, matching the other tools' API)
// ---------------------------------------------------------------------------

export function createScreenshotTool(): AgentTool<typeof screenshotSchema> {
  return wrapToolDefinition(createScreenshotToolDefinition());
}
export function createMouseMoveTool(): AgentTool<typeof mouseMoveSchema> {
  return wrapToolDefinition(createMouseMoveToolDefinition());
}
export function createMouseClickTool(): AgentTool<typeof mouseClickSchema> {
  return wrapToolDefinition(createMouseClickToolDefinition());
}
export function createMouseDragTool(): AgentTool<typeof mouseDragSchema> {
  return wrapToolDefinition(createMouseDragToolDefinition());
}
export function createKeyEventTool(): AgentTool<typeof keyEventSchema> {
  return wrapToolDefinition(createKeyEventToolDefinition());
}
export function createTypeTextTool(): AgentTool<typeof typeTextSchema> {
  return wrapToolDefinition(createTypeTextToolDefinition());
}
export function createGetAxAtPointTool(): AgentTool<typeof getAxAtPointSchema> {
  return wrapToolDefinition(createGetAxAtPointToolDefinition());
}
export function createGetFocusedAxTool(): AgentTool<typeof getFocusedAxSchema> {
  return wrapToolDefinition(createGetFocusedAxToolDefinition());
}
