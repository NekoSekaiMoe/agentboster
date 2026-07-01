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
    };
  },
});
