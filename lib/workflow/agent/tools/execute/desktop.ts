import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

/**
 * Desktop-tool dispatcher.
 *
 * Mirrors the browser-tool dispatcher pattern (see ./browser.ts), but
 * routes to the agentd `desktop_screenshot` tool which provisions an
 * X11 desktop (Xvfb + icewm + x11vnc + noVNC) inside the sandbox and
 * captures a screenshot from the Xvfb framebuffer via `import`.
 *
 * Scope: registered for IM / CLI / scheduled sessions (Web-UI excluded,
 * same gate as browser tools — see ./browser.ts for the rationale).
 *
 * Result handling: agentd returns a JSON string in ToolResult.Data with
 * the shape { image: dataURL, novnc_port, novnc_path, novnc_hint, ... }.
 * This dispatcher parses that payload and re-emits it as an AI SDK
 * image content block so vision-capable models (Claude, GPT-4o, Gemini)
 * receive the screenshot as an actual image rather than an opaque
 * base64 string. The noVNC connection info is forwarded as a separate
 * text content part so the model can quote it to the user verbatim.
 *
 * If the agentd response is malformed or missing the image field, the
 * raw envelope is surfaced as text — never silently swallowed.
 */

const nodeIdParam = z
  .string()
  .optional()
  .describe(
    'Specific agentd node ID to execute on. If not provided, automatically selects the best node.',
  );

type DesktopResultPayload = {
  image?: string; // data:image/png;base64,...
  format?: string;
  display?: string;
  novnc_port?: number;
  novnc_path?: string;
  novnc_hint?: string;
};

/**
 * Forward a desktop_* tool call to agentd. Same 'use step' constraint
 * as dispatchBrowserTool (execToolOnAgentd reads the agentd nodes
 * table via neon-http, which needs host-side fetch).
 *
 * On success, returns one image content block + one text content block
 * (the latter carries the noVNC URL hint). On error, returns a single
 * text block with the daemon's error string.
 */
async function dispatchDesktopTool(input: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  nodeId?: string;
}): Promise<{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: string; mimeType: string }
  >;
}> {
  'use step';
  const { execToolOnAgentd } = await import(
    '@/lib/extra/agent/agentd-tools-client'
  );
  const { isAgentdAvailable } = await import('../../dispatch');

  const available = await isAgentdAvailable().catch(() => false);
  if (!available) {
    return {
      content: [
        {
          type: 'text',
          text: 'No agentd node is online. desktop_* tools require a connected daemon with a persistent LXC sandbox; they are not available on the serverless side. Try again once an agentd node has registered.',
        },
      ],
    };
  }

  const result = await execToolOnAgentd(
    input.sessionId,
    input.toolName,
    input.toolInput,
    input.nodeId,
  );

  if (!result?.success) {
    return {
      content: [
        {
          type: 'text',
          text: `desktop tool "${input.toolName}" failed: ${result?.error ?? 'unknown error'}`,
        },
      ],
    };
  }

  // agentd returns ToolResult.Data as a JSON-encoded string. Parse it;
  // if parsing fails or the image field is missing, surface the raw
  // payload as text (the model can still read connection info from it).
  const raw = typeof result.data === 'string' ? result.data : '';
  let payload: DesktopResultPayload | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as DesktopResultPayload) : null;
  } catch {
    payload = null;
  }

  if (!payload || typeof payload.image !== 'string' || !payload.image) {
    return {
      content: [
        {
          type: 'text',
          text: raw || `(empty response from desktop tool "${input.toolName}")`,
        },
      ],
    };
  }

  // Strip the data: prefix; the AI SDK ImagePart takes raw base64 (or a
  // data URL — both work, but raw base64 + explicit mimeType is the
  // better-supported form across providers).
  const dataUrl = payload.image;
  const base64Match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  const mimeType = base64Match?.[1] ?? 'image/png';
  const base64 = base64Match?.[2] ?? dataUrl;

  const blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: string; mimeType: string }
  > = [
    {
      type: 'image',
      image: base64,
      mimeType,
    },
  ];

  // Append a text block with the noVNC connection info so the model can
  // tell the user how to open the live desktop view. The hint includes
  // the port to expose via sandbox.public_port and the path to append.
  const textParts: string[] = [];
  if (payload.display) textParts.push(`Display: ${payload.display}`);
  if (payload.novnc_port) {
    textParts.push(
      `Live desktop: expose port ${payload.novnc_port} via sandbox.public_port, then open the returned URL with path ${payload.novnc_path ?? '/vnc.html'}.`,
    );
  }
  if (payload.novnc_hint) textParts.push(payload.novnc_hint);
  if (textParts.length > 0) {
    blocks.push({ type: 'text', text: textParts.join('\n') });
  }

  return { content: blocks };
}

export default defineBuildInTool({
  id: 'desktop',
  description: `X11 desktop in the agentd LXC sandbox for debugging GUI applications (Electron / Tauri / Qt / GTK). The desktop_screenshot tool auto-provisions Xvfb + icewm + x11vnc + noVNC on first call (~30s cold start, cached afterwards) and captures a lossless PNG of the X11 framebuffer for vision-capable models. The user can view the live desktop in their browser by exposing the noVNC port via sandbox.public_port. Useful for: GUI test automation, debugging layout issues in desktop apps, taking visual verification screenshots.`,
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { sessionId, source }) => {
    // Same gate as browser tools: Web-UI sessions have no agentd peer.
    if (source?.type === 'web') {
      return null;
    }

    const ctx = { sessionId };

    return {
      desktop_screenshot: tool({
        title: 'Capture the X11 desktop as a PNG',
        description:
          'Capture a lossless PNG of the X11 framebuffer in the sandbox. Returns an image content block (vision-capable models see the actual screenshot) plus the noVNC connection info so you can guide the user to open the live desktop view. On first call, provisions Xvfb + icewm + x11vnc + noVNC inside the sandbox (~30s); subsequent calls are fast. Use this to debug GUI applications, verify layout, or capture visual state for the user.',
        inputSchema: z.object({
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_screenshot',
            toolInput: {},
            nodeId: input.nodeId,
          }),
      }),

      desktop_click: tool({
        title: 'Click at (x, y) on the sandbox desktop',
        description:
          'Inject a mouse click at the given X11 framebuffer coordinates. Use desktop_screenshot first to see the current layout and pick coordinates. Coordinates are in pixels from top-left. button: 1=left (default), 2=middle, 3=right, 4=wheel-up, 5=wheel-down. click_count: 1 (default), 2=double, 3=triple. Independent of whether a noVNC client is connected (uses xdotool XTest).',
        inputSchema: z.object({
          x: z.number().int().describe('X coordinate (pixels from left).'),
          y: z.number().int().describe('Y coordinate (pixels from top).'),
          button: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe(
              '1=left, 2=middle, 3=right, 4=wheel-up, 5=wheel-down. Default 1.',
            ),
          click_count: z
            .number()
            .int()
            .min(1)
            .max(3)
            .optional()
            .describe(
              'Number of clicks (1=single, 2=double, 3=triple). Default 1.',
            ),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_click',
            toolInput: {
              x: input.x,
              y: input.y,
              button: input.button,
              click_count: input.click_count,
            },
            nodeId: input.nodeId,
          }),
      }),

      desktop_type: tool({
        title: 'Type text into the focused window',
        description:
          'Type text into the currently focused window on the sandbox desktop. Use desktop_click first to focus an input field, then desktop_type to enter text. Handles UTF-8 and arbitrary characters safely (text is piped to xdotool via stdin, not passed as a shell argument).',
        inputSchema: z.object({
          text: z
            .string()
            .min(1)
            .describe(
              'Text to type. May contain any characters including newlines.',
            ),
          delay_ms: z
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe(
              'Per-keystroke delay in ms. Default 0 (as fast as possible).',
            ),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_type',
            toolInput: {
              text: input.text,
              delay_ms: input.delay_ms,
            },
            nodeId: input.nodeId,
          }),
      }),

      desktop_key: tool({
        title: 'Press a key or key combo',
        description:
          'Press a key or key combo on the sandbox desktop. Examples: "Return" (Enter), "Escape", "ctrl+c", "Alt+F4", "ctrl+shift+t", "Tab", "BackSpace", "space". Keys follow xdotool/X11 naming (see /usr/include/X11/keysymdef.h, strip the XK_ prefix). Multiple keys joined with \'+\' are pressed simultaneously.',
        inputSchema: z.object({
          keysym: z
            .string()
            .min(1)
            .describe('Key or combo, e.g. "Return", "ctrl+c", "Alt+F4".'),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_key',
            toolInput: {
              keysym: input.keysym,
            },
            nodeId: input.nodeId,
          }),
      }),

      desktop_inspect: tool({
        title: 'Return the desktop accessibility tree',
        description:
          'Walk the AT-SPI2 accessibility tree inside the sandbox and return a compact text list of on-screen widgets. ' +
          'Each widget becomes one line: `- push button "Reload" [ref=e3] @120,80 28x28`. ' +
          'Use the refs (eN) with desktop_a11y_click / desktop_a11y_type for precise, semantic GUI automation. ' +
          'Much cheaper than desktop_screenshot (no image bytes), and works even when the target is off-screen but exposed by the toolkit. ' +
          'Falls back gracefully on apps without AT-SPI support (raw X11 apps like xterm return an empty tree). ' +
          'First call provisions Xvfb + icewm + x11vnc + noVNC + at-spi2 + the helper binary (~30-60s); subsequent calls are fast.',
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe(
              'Max number of widgets to return. Default 300. Hard cap prevents pathological trees (LibreOffice Calc) from hanging.',
            ),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_inspect',
            toolInput: {
              limit: input.limit,
            },
            nodeId: input.nodeId,
          }),
      }),

      desktop_a11y_click: tool({
        title: 'Click a widget by accessibility ref',
        description:
          'Click an on-screen widget by its accessibility ref (the eN id from desktop_inspect). ' +
          'Routes through the AT-SPI Action interface for precise, semantic interaction. ' +
          'If AT-SPI cannot reach the target (raw-X11 apps, widgets without an Action interface), ' +
          'automatically falls back to a coordinate click via xdotool using the bounding-box center captured at snapshot time. ' +
          'Always call desktop_inspect first to get refs.',
        inputSchema: z.object({
          ref: z
            .string()
            .min(1)
            .describe(
              'Accessibility ref from desktop_inspect (e.g. "e3"). Accepts e3 / E03 / ref=e3 / 3.',
            ),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_a11y_click',
            toolInput: {
              ref: input.ref,
            },
            nodeId: input.nodeId,
          }),
      }),

      desktop_a11y_type: tool({
        title: 'Type text into a widget by accessibility ref',
        description:
          'Type text into the editable widget pointed at by an accessibility ref. ' +
          'Inserts at the caret via the AT-SPI EditableText interface. ' +
          'If AT-SPI cannot reach the target, falls back to clicking the bounding-box center and typing via xdotool. ' +
          'Always call desktop_inspect first to get refs.',
        inputSchema: z.object({
          ref: z
            .string()
            .min(1)
            .describe('Accessibility ref from desktop_inspect.'),
          text: z.string().min(1).describe('Text to type. UTF-8 safe.'),
          mode: z
            .enum(['insert', 'replace'])
            .optional()
            .describe(
              'insert (default) inserts at the caret; replace overwrites the whole field.',
            ),
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchDesktopTool({
            ...ctx,
            toolName: 'desktop_a11y_type',
            toolInput: {
              ref: input.ref,
              text: input.text,
              mode: input.mode,
            },
            nodeId: input.nodeId,
          }),
      }),
    };
  },
});
