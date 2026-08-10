import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

/**
 * Browser-tool dispatcher.
 *
 * These `browser_*` tools are thin wrappers that forward to the agentd
 * daemon via `execToolOnAgentd(sessionId, 'browser_*', input)`. The
 * daemon owns the real Playwright helper (agentd/internal/agent/browser/
 * bridge.js) and registers the matching tool names in its own registry
 * (agentd/internal/agent/tools_browser_v2.go), so Web-side dispatch is
 * a pure pass-through — no parameter transformation, no result parsing
 * beyond surfacing the daemon's `{ success, data, error }` envelope.
 *
 * Scope: registered for IM / CLI / scheduled sessions, which always
 * route through agentd. Web-UI sessions (`source.type === 'web'`) are
 * excluded on purpose — they have no daemon peer wired up and would
 * only ever hit the "no online node" error path. (A serverless
 * browser pool exists in lib/mcp/browser/, but is intentionally not
 * exposed here — see config.ts DEFAULT_SYSTEM_PROMPT for the routing
 * rationale.)
 *
 * Multi-tab tools (`browser_tab_*`) and the new browser_select_option /
 * browser_hover / browser_upload trio were added in the same change as
 * this file; tool names mirror agentd's registry 1:1 so the daemon
 * resolves them without translation.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Shared "which agentd node" parameter — same shape as sandbox.exec's
 * nodeId. Optional; when omitted, the daemon picks the best online
 * node via dispatch.selectBestNode.
 */
const nodeIdParam = z
  .string()
  .optional()
  .describe(
    'Specific agentd node ID to execute on. If not provided, automatically selects the best node.',
  );

const profileParam = z
  .string()
  .optional()
  .describe(
    'Browser profile name. Defaults to an agent-scoped profile so concurrent agents do not collide. Profiles persist on the agentd node across sessions.',
  );

const timeoutParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    `Per-call Playwright wait timeout in ms. Default ${DEFAULT_TIMEOUT_MS} ms.`,
  );

/**
 * Forward a browser_* tool call to agentd. Wraps execToolOnAgentd to
 * normalize the result envelope into the AI SDK's `tool` result shape
 * (an array of content parts). Defers the dynamic imports so the
 * surrounding workflow vm sandbox stays clean.
 *
 * Marked `'use step'` because execToolOnAgentd reads the agentd nodes
 * table via neon-http (which needs host-side `fetch`); see
 * lib/workflow/agent/tools/agentd/nodes.ts for the same constraint.
 *
 * `browser_screenshot` is special-cased: agentd returns
 * `{ data: { bytes, mime, base64 } }` (pretty-printed as JSON in
 * ToolResult.Data), and naively surfacing that string would feed the
 * model a wall of base64 ASCII through the text channel — hundreds of
 * thousands of tokens for a single 1280x720 PNG, with no vision. We
 * parse the envelope and re-emit it as an `{ type: 'image' }` content
 * part so vision-capable providers actually see the picture. Every
 * other tool returns structured text (clicked/target/title/url/...)
 * which is forwarded as-is. Mirrors the desktop dispatcher's pattern
 * (see ./desktop.ts).
 */
async function dispatchBrowserTool(input: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  nodeId?: string;
  /** Whether the per-workspace run lock was acquired this run. When false,
   *  suppress workspace_id so agentd uses a short-lived ephemeral container
   *  instead of binding the long-lived workspace container. */
  workspaceLockAcquired?: boolean;
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
          text: 'No agentd node is online. browser_* tools require a connected daemon; they are not available on the serverless side. Try again once an agentd node has registered.',
        },
      ],
    };
  }

  const result = await execToolOnAgentd(
    input.sessionId,
    input.toolName,
    input.toolInput,
    input.nodeId,
    undefined,
    input.workspaceLockAcquired,
  );

  if (!result?.success) {
    return {
      content: [
        {
          type: 'text',
          text: `browser tool "${input.toolName}" failed: ${result?.error ?? 'unknown error'}`,
        },
      ],
    };
  }

  // agentd returns { success, data, error } where `data` is a JSON
  // string OR a plain string. For non-screenshot tools, surface it
  // as-is — Playwright's structured outputs (clicked/target/title/url)
  // are useful to the model.
  const raw = result.data ?? '';
  const text =
    typeof raw === 'string' && raw.length > 0 ? raw : JSON.stringify(raw);

  // browser_screenshot is the only tool whose payload is binary image
  // data. Forward it as a vision image block instead of text so the
  // base64 doesn't explode the text channel (a 1280x720 PNG is
  // ~200-600k tokens as ASCII base64 vs ~1.5k as a vision image part).
  if (input.toolName === 'browser_screenshot' && typeof raw === 'string') {
    try {
      const envelope = JSON.parse(raw) as {
        data?: { base64?: string; mime?: string };
      };
      const base64 = envelope?.data?.base64;
      const mime = envelope?.data?.mime;
      if (typeof base64 === 'string' && base64.length > 0 && mime) {
        return {
          content: [{ type: 'image', image: base64, mimeType: mime }],
        };
      }
    } catch {
      // fall through to text surfacing below
    }
  }

  return { content: [{ type: 'text', text }] };
}

export default defineBuildInTool({
  id: 'browser',
  description: `Playwright-backed browser automation (navigate / click / type / screenshot / evaluate / select_option / hover / upload / multi-tab) running on an agentd node's persistent LXC sandbox. Profiles persist across sessions. Use these when the task needs real browser interaction (login flows, JS-rendered pages, file uploads, multi-tab workflows). Requires at least one online agentd node; not available in the serverless-only Web UI path.`,
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { sessionId, source, workspaceLockAcquired }) => {
    // Gate: browser_* always run on agentd. Web-UI sessions have no
    // daemon peer and would only ever hit the "no online node" error
    // path — exclude them so the catalog stays honest. CLI / IM /
    // scheduled sessions all dispatch through agentd normally.
    if (source?.type === 'web') {
      return null;
    }

    const ctx = {
      sessionId,
      workspaceLockAcquired,
    };

    return {
      browser_navigate: tool({
        title: 'Navigate the browser to a URL',
        description:
          'Open a URL in the browser profile. The first call lazily bootstraps Playwright inside the agentd sandbox (~30–60s cold start); subsequent calls reuse the warm helper. Run this before any other browser_* tool.',
        inputSchema: z.object({
          url: z.string().url().describe('Absolute http(s) URL.'),
          user_agent: z
            .string()
            .optional()
            .describe('Override the User-Agent string.'),
          wait_until: z
            .enum(['load', 'domcontentloaded', 'networkidle'])
            .optional()
            .describe('Playwright waitUntil. Default domcontentloaded.'),
          timeout_ms: timeoutParam,
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_navigate',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_inspect: tool({
        title: 'Inspect the page to discover stable locators',
        description:
          'Snapshot the page and return recommended locator strategies (role+name, label, placeholder, selector) for each interactive element. Run this before browser_click when you do not already have a stable selector — avoids brittle CSS selectors on modern frameworks (Tailwind, dynamic class names).',
        inputSchema: z.object({
          selector: z
            .string()
            .optional()
            .describe('Optional root selector to scope the snapshot.'),
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_inspect',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_click: tool({
        title: 'Click an element',
        description:
          'Click an element using one of the locator strategies (selector / role+role_name / label / placeholder / text) or page coordinates (x, y). Prefer role+role_name or label for stability; run browser_inspect first when unsure.',
        inputSchema: z.object({
          selector: z.string().optional(),
          role: z
            .enum([
              'button',
              'link',
              'textbox',
              'checkbox',
              'radio',
              'menuitem',
              'option',
              'switch',
              'tab',
              'combobox',
              'listbox',
              'slider',
              'searchbox',
              'spinbutton',
            ])
            .optional(),
          role_name: z
            .string()
            .optional()
            .describe('Accessible name to disambiguate the role.'),
          role_exact: z.boolean().optional(),
          label: z.string().optional(),
          label_exact: z.boolean().optional(),
          placeholder: z.string().optional(),
          placeholder_exact: z.boolean().optional(),
          text: z.string().optional(),
          text_exact: z.boolean().optional(),
          frame_chain: z
            .array(z.string())
            .optional()
            .describe(
              'iframe selectors to drill into nested frames, outer-first.',
            ),
          x: z
            .number()
            .optional()
            .describe('X coordinate (used when no locator strategy given).'),
          y: z
            .number()
            .optional()
            .describe('Y coordinate (used when no locator strategy given).'),
          button: z.enum(['left', 'middle', 'right']).optional(),
          click_count: z.number().int().min(1).max(3).optional(),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_click',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_type: tool({
        title: 'Type text into a field',
        description:
          'Focus an element via a locator strategy and type text into it. Set clear=true to replace existing content. Set press_enter=true to submit the field after typing (handy for search boxes).',
        inputSchema: z.object({
          selector: z.string().optional(),
          role: z.string().optional(),
          role_name: z.string().optional(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          text: z.string().min(1).describe('The text to type. Required.'),
          clear: z
            .boolean()
            .optional()
            .describe(
              'Clear the field before typing (fill mode). Default false (append-style pressSequentially).',
            ),
          press_enter: z.boolean().optional(),
          delay_ms: z
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe(
              'Per-keystroke delay in ms (pressSequentially mode only).',
            ),
          frame_chain: z.array(z.string()).optional(),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_type',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_get_text: tool({
        title: 'Get visible text of the page or an element',
        description:
          'Return the innerText of the page body (or a sub-element when selector is given). Use this to read what is actually visible after JavaScript rendering — preferred over fetch_url for SPA-style pages once the browser is open.',
        inputSchema: z.object({
          selector: z.string().optional(),
          max_length: z.number().int().positive().max(50_000).optional(),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_get_text',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_get_html: tool({
        title: 'Get HTML of the page or an element',
        description:
          'Return the outerHTML of the page (or a sub-element when selector is given). Heavier than browser_get_text; use only when you actually need the markup (e.g. scraping structured content).',
        inputSchema: z.object({
          selector: z.string().optional(),
          max_length: z.number().int().positive().max(100_000).optional(),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_get_html',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_screenshot: tool({
        title: 'Capture a screenshot',
        description:
          'Capture a screenshot of the page (full_page=true for the entire scrollable document) or a specific element (selector). Defaults to JPEG quality 80 — 5-10x smaller than PNG on both upload latency and per-turn vision token cost, with negligible recognition loss. Set type="png" when pixel-perfect output is required (e.g. comparing sub-pixel rendering). Useful for visual verification, debugging layout issues, and capturing canvas-based content that browser_get_text cannot read.',
        inputSchema: z.object({
          selector: z
            .string()
            .optional()
            .describe('Element to capture. Default: viewport.'),
          full_page: z
            .boolean()
            .optional()
            .describe('Capture the full scrollable page. Default false.'),
          type: z
            .enum(['png', 'jpeg'])
            .optional()
            .describe(
              'Image format. Default "jpeg" (5-10x smaller than PNG at q80, negligible vision loss). Use "png" for pixel-perfect output.',
            ),
          quality: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('JPEG quality (1-100). Default 80. PNG ignores this.'),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_screenshot',
            // Default to JPEG q80 to cut screenshot cost ~5-10x vs PNG.
            // The agentd bridge already accepts these fields; we just
            // backfill defaults so an unspecified call goes down as a
            // small JPEG rather than a ~1.5MB PNG. The LLM can still
            // explicitly ask for type="png" when it needs lossless.
            toolInput: {
              ...input,
              type: input.type ?? 'jpeg',
              quality: input.quality ?? 80,
            },
            nodeId: input.nodeId,
          }),
      }),

      browser_evaluate: tool({
        title: 'Run arbitrary JavaScript in the page',
        description:
          'Evaluate a JavaScript expression in the page context and return its result. Use as an escape hatch when no dedicated browser_* tool fits (e.g. reading computed CSS, calling a page API, parsing DOM directly). Avoid for interaction — prefer the typed tools.',
        inputSchema: z.object({
          script: z
            .string()
            .min(1)
            .describe(
              'JavaScript expression to evaluate. Must be a single expression or an async IIFE; result is JSON-serialized.',
            ),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_evaluate',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_save_state: tool({
        title: 'Export browser state (cookies + storage)',
        description:
          "Snapshot the current profile's cookies and localStorage to a storageState JSON blob. Use to migrate a login session to another agentd node or to persist state through serverless restarts (combine with the memory tool's writeMemory action).",
        inputSchema: z.object({
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_save_state',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_load_state: tool({
        title: 'Import browser state (cookies + storage)',
        description:
          'Restore a previously saved storageState JSON into the current profile. Accepts the exact shape produced by browser_save_state. Useful for resuming a login without re-doing a flow.',
        inputSchema: z.object({
          state: z
            .string()
            .min(1)
            .describe('storageState JSON blob (from browser_save_state).'),
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_load_state',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_list_profiles: tool({
        title: 'List browser profiles',
        description:
          'Enumerate the persisted browser profiles on the agentd node. Useful when managing multiple login contexts (e.g. a work account vs. a test account).',
        inputSchema: z.object({
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_list_profiles',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_close: tool({
        title: 'Close the browser session',
        description:
          "Close the current profile's browser context, releasing Playwright resources. Call once you are done with all browser tasks for a session — cold-starting the helper again costs ~30–60s. The profile's persisted cookies/localStorage are NOT deleted by close.",
        inputSchema: z.object({
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_close',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_select_option: tool({
        title: 'Select option(s) on a <select> or checkbox/radio group',
        description:
          'Select one or more options on a <select> element, or check <input type=checkbox|radio> matched by the locator. Use value (single) for normal <select>, or values (array) for <select multiple> or a group of same-named checkboxes. Resolve the target with role / label / selector — run browser_inspect first when unsure.',
        inputSchema: z.object({
          selector: z.string().optional(),
          role: z.string().optional(),
          role_name: z.string().optional(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          text: z.string().optional(),
          frame_chain: z.array(z.string()).optional(),
          value: z
            .string()
            .optional()
            .describe('Single option value. Mutually exclusive with values.'),
          values: z
            .array(z.string())
            .optional()
            .describe(
              'Multiple option values (for <select multiple> or a checkbox group). Ignored if value is set.',
            ),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_select_option',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_hover: tool({
        title: 'Hover over an element',
        description:
          'Hover over an element matched by a locator strategy. Triggers hover-only UI such as dropdown menus, tooltips, and lazy image loading. Use a locator strategy (selector / role / label / ...); pure coordinate hover is not supported.',
        inputSchema: z.object({
          selector: z.string().optional(),
          role: z.string().optional(),
          role_name: z.string().optional(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          text: z.string().optional(),
          frame_chain: z.array(z.string()).optional(),
          modifiers: z
            .array(z.enum(['Shift', 'Control', 'Alt', 'Meta']))
            .optional()
            .describe('Modifier keys to hold during hover.'),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_hover',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_upload: tool({
        title: 'Upload file(s) into an <input type=file>',
        description:
          'Upload file(s) into an <input type=file> element matched by a locator strategy. Use paths / paths_array for files that already exist on the agentd sandbox filesystem; use payload + name for small in-memory text payloads (binary must be written to a sandbox path first).',
        inputSchema: z.object({
          selector: z.string().optional(),
          role: z.string().optional(),
          role_name: z.string().optional(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          text: z.string().optional(),
          frame_chain: z.array(z.string()).optional(),
          paths: z
            .string()
            .optional()
            .describe(
              'Comma-separated absolute paths inside the agentd sandbox (e.g. "/workspace/in.csv").',
            ),
          paths_array: z
            .array(z.string())
            .optional()
            .describe('Array form of paths (use when paths contain commas).'),
          payload: z
            .string()
            .optional()
            .describe(
              'Inline text payload (UTF-8). Use with name. For binary, write to a sandbox path and use paths.',
            ),
          name: z
            .string()
            .optional()
            .describe('Filename when using payload. Required with payload.'),
          mime: z
            .string()
            .optional()
            .describe(
              'MIME type when using payload (default application/octet-stream).',
            ),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_upload',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_tab_new: tool({
        title: 'Open a new browser tab',
        description:
          "Open a new tab in the current profile's browser context and switch to it. Returns the new tabId. Optionally navigate it to a URL. Subsequent browser_* calls target this new tab until browser_tab_switch is used.",
        inputSchema: z.object({
          url: z
            .string()
            .url()
            .optional()
            .describe('URL to navigate the new tab to. Default: about:blank.'),
          timeout_ms: timeoutParam,
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_tab_new',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_tab_switch: tool({
        title: 'Switch the active tab',
        description:
          'Make an existing tabId the active tab for subsequent browser_* calls. Use browser_tab_list to discover tab ids.',
        inputSchema: z.object({
          tab_id: z
            .string()
            .min(1)
            .describe(
              'Tab id returned by browser_tab_new or browser_tab_list.',
            ),
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_tab_switch',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_tab_close: tool({
        title: 'Close a tab',
        description:
          'Close a browser tab. Defaults to the current tab. The profile always retains at least one tab so subsequent browser_* calls keep working — closing the last tab auto-spawns a fresh blank one.',
        inputSchema: z.object({
          tab_id: z
            .string()
            .optional()
            .describe('Tab id to close. If omitted, closes the current tab.'),
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_tab_close',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),

      browser_tab_list: tool({
        title: 'List all browser tabs',
        description:
          'List all tabs in the current profile with their id, URL, title, and which is currently active. Use after browser_tab_new to capture ids for later switch/close.',
        inputSchema: z.object({
          profile: profileParam,
          nodeId: nodeIdParam,
        }),
        execute: (input) =>
          dispatchBrowserTool({
            ...ctx,
            toolName: 'browser_tab_list',
            toolInput: input,
            nodeId: input.nodeId,
          }),
      }),
    };
  },
});
