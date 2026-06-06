import type { JSONValue } from '@ai-sdk/provider';

import { getBrowserPool } from '@/lib/mcp/browser/pool';
import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from '@/lib/mcp/builtin/types';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TEXT_LIMIT = 20_000;
const DEFAULT_HTML_LIMIT = 50_000;
const DEFAULT_NETWORK_LIMIT = 50;
const MAX_EVALUATE_LENGTH = 10_000;

type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const removed = value.length - maxLength;
  return `${value.slice(0, maxLength)}\n\n[truncated: ${removed} characters removed]`;
}

function safeStringify(value: unknown, maxLength = DEFAULT_TEXT_LIMIT): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return truncate(serialized ?? String(value), maxLength);
  } catch {
    return String(value);
  }
}

function stringInput(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function numberInput(
  input: Record<string, unknown>,
  key: string,
): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanInput(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

function timeoutInput(input: Record<string, unknown>): number {
  const timeout = numberInput(input, 'timeout_ms');
  if (!timeout || timeout <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.floor(timeout), MAX_TIMEOUT_MS);
}

function limitInput(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const limit = numberInput(input, key);
  if (!limit || limit <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(limit), fallback);
}

function waitUntilInput(input: Record<string, unknown>): WaitUntil {
  const value = stringInput(input, 'wait_until');
  if (
    value === 'commit' ||
    value === 'domcontentloaded' ||
    value === 'load' ||
    value === 'networkidle'
  ) {
    return value;
  }

  return 'domcontentloaded';
}

function validateHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

async function getSession(context?: BuiltinMcpServerContext) {
  return getBrowserPool().getSession(context?.sessionId);
}

export const browserTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'browser_navigate',
    title: 'Browser Navigate',
    description:
      'Open an HTTP(S) URL in a reusable headless browser page. Use for JavaScript-rendered pages or interactive inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        wait_until: {
          type: 'string',
          enum: ['commit', 'domcontentloaded', 'load', 'networkidle'],
        },
        timeout_ms: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    title: 'Browser Screenshot',
    description:
      'Capture the current browser page, or a selected element, as a PNG/JPEG image.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        full_page: { type: 'boolean' },
        type: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'number' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_click',
    title: 'Browser Click',
    description:
      'Click an element by CSS/text selector, or click page coordinates with x and y.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        click_count: { type: 'number' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_type',
    title: 'Browser Type',
    description:
      'Type text into the focused element, or into a selector after focusing/clicking it.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        press_enter: { type: 'boolean' },
        delay_ms: { type: 'number' },
        timeout_ms: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_get_text',
    title: 'Browser Get Text',
    description:
      'Return visible text from the current page body, or from a selected element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        max_length: { type: 'number' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_get_html',
    title: 'Browser Get HTML',
    description:
      'Return current page HTML, or inner HTML from a selected element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        max_length: { type: 'number' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_get_network_requests',
    title: 'Browser Get Network Requests',
    description:
      'Return recent network requests observed by the browser page, including status and failures.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_evaluate',
    title: 'Browser Evaluate',
    description:
      'Evaluate JavaScript in the current page. Return a serializable value from the script.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['script'],
    },
  },
  {
    name: 'browser_close',
    title: 'Browser Close',
    description:
      'Close the reusable browser page for the current session and release resources.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function executeBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  context?: BuiltinMcpServerContext,
): Promise<BuiltinMcpToolResult> {
  try {
    if (toolName === 'browser_navigate') {
      const url = validateHttpUrl(stringInput(input, 'url'));
      if (!url) {
        return buildError('Missing or invalid HTTP(S) URL.');
      }

      const session = await getSession(context);
      const width = numberInput(input, 'width');
      const height = numberInput(input, 'height');
      if (width && height && width > 0 && height > 0) {
        await session.page.setViewportSize({
          width: Math.floor(width),
          height: Math.floor(height),
        });
      }

      const response = await session.page.goto(url, {
        waitUntil: waitUntilInput(input),
        timeout: timeoutInput(input),
      });
      const title = await session.page.title();
      const result = {
        url: session.page.url(),
        title,
        status: response?.status() ?? null,
        ok: response?.ok() ?? null,
      };

      return {
        content: [{ type: 'text', text: safeStringify(result) }],
        structuredContent: toJsonValue(result),
      };
    }

    if (toolName === 'browser_screenshot') {
      const session = await getSession(context);
      const selector = stringInput(input, 'selector');
      const type = stringInput(input, 'type') === 'jpeg' ? 'jpeg' : 'png';
      const quality = numberInput(input, 'quality');
      const options = {
        type,
        timeout: timeoutInput(input),
        ...(type === 'jpeg' && quality
          ? { quality: Math.max(0, Math.min(100, Math.floor(quality))) }
          : {}),
      } as const;
      const screenshot = selector
        ? await session.page.locator(selector).screenshot(options)
        : await session.page.screenshot({
            ...options,
            fullPage: booleanInput(input, 'full_page'),
          });
      const data = screenshot.toString('base64');
      const mimeType = `image/${type}`;

      return {
        content: [
          {
            type: 'text',
            text: `Captured ${selector ? `element "${selector}"` : 'page'} screenshot (${mimeType}, ${screenshot.byteLength} bytes).`,
          },
          { type: 'image', data, mimeType },
        ],
        structuredContent: toJsonValue({
          mimeType,
          bytes: screenshot.byteLength,
          selector: selector || null,
          fullPage: booleanInput(input, 'full_page'),
        }),
      };
    }

    if (toolName === 'browser_click') {
      const session = await getSession(context);
      const selector = stringInput(input, 'selector');
      const x = numberInput(input, 'x');
      const y = numberInput(input, 'y');
      const button = stringInput(input, 'button');
      const clickCount = numberInput(input, 'click_count');
      const clickButton: 'left' | 'middle' | 'right' =
        button === 'middle' || button === 'right' ? button : 'left';
      const clickOptions = {
        button: clickButton,
        clickCount:
          clickCount && clickCount > 0
            ? Math.min(Math.floor(clickCount), 3)
            : 1,
      };

      if (selector) {
        await session.page.locator(selector).click({
          ...clickOptions,
          timeout: timeoutInput(input),
        });
        return {
          content: [{ type: 'text', text: `Clicked selector: ${selector}` }],
        };
      }

      if (x === null || y === null) {
        return buildError('Provide either selector, or both x and y.');
      }

      await session.page.mouse.click(x, y, clickOptions);
      return {
        content: [{ type: 'text', text: `Clicked coordinates: ${x}, ${y}` }],
      };
    }

    if (toolName === 'browser_type') {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text) {
        return buildError('Missing required field: text');
      }

      const session = await getSession(context);
      const selector = stringInput(input, 'selector');
      const delay = numberInput(input, 'delay_ms');
      const typeOptions = {
        delay: delay && delay > 0 ? Math.min(Math.floor(delay), 1000) : 0,
        timeout: timeoutInput(input),
      };

      if (selector) {
        const locator = session.page.locator(selector);
        if (booleanInput(input, 'clear')) {
          await locator.fill(text, { timeout: timeoutInput(input) });
        } else {
          await locator.click({ timeout: timeoutInput(input) });
          await locator.pressSequentially(text, typeOptions);
        }
      } else {
        await session.page.keyboard.type(text, { delay: typeOptions.delay });
      }

      if (booleanInput(input, 'press_enter')) {
        await session.page.keyboard.press('Enter');
      }

      return {
        content: [
          {
            type: 'text',
            text: selector
              ? `Typed ${text.length} characters into selector: ${selector}`
              : `Typed ${text.length} characters into the focused element.`,
          },
        ],
      };
    }

    if (toolName === 'browser_get_text') {
      const session = await getSession(context);
      const selector = stringInput(input, 'selector');
      const limit = limitInput(input, 'max_length', DEFAULT_TEXT_LIMIT);
      const text = selector
        ? await session.page.locator(selector).innerText({
            timeout: timeoutInput(input),
          })
        : await session.page.locator('body').innerText({
            timeout: timeoutInput(input),
          });

      return {
        content: [{ type: 'text', text: truncate(text, limit) }],
      };
    }

    if (toolName === 'browser_get_html') {
      const session = await getSession(context);
      const selector = stringInput(input, 'selector');
      const limit = limitInput(input, 'max_length', DEFAULT_HTML_LIMIT);
      const html = selector
        ? await session.page.locator(selector).innerHTML({
            timeout: timeoutInput(input),
          })
        : await session.page.content();

      return {
        content: [{ type: 'text', text: truncate(html, limit) }],
      };
    }

    if (toolName === 'browser_get_network_requests') {
      const limit = limitInput(input, 'limit', DEFAULT_NETWORK_LIMIT);
      const requests = getBrowserPool()
        .getNetworkRequests(context?.sessionId)
        .slice(-limit);

      return {
        content: [{ type: 'text', text: safeStringify(requests, 30_000) }],
        structuredContent: toJsonValue({ requests }),
      };
    }

    if (toolName === 'browser_evaluate') {
      const script =
        typeof input.script === 'string' ? input.script.trim() : '';
      if (!script) {
        return buildError('Missing required field: script');
      }
      if (script.length > MAX_EVALUATE_LENGTH) {
        return buildError(
          `Script is too long. Maximum length is ${MAX_EVALUATE_LENGTH} characters.`,
        );
      }

      const session = await getSession(context);
      session.page.setDefaultTimeout(timeoutInput(input));
      const result = await session.page.evaluate(`(() => {
        const source = ${JSON.stringify(script)};
        try {
          return Function('"use strict"; return (' + source + ');')();
        } catch (expressionError) {
          if (expressionError instanceof SyntaxError) {
            return Function('"use strict";' + source)();
          }
          throw expressionError;
        }
      })()`);

      return {
        content: [{ type: 'text', text: safeStringify(result, 30_000) }],
        structuredContent: toJsonValue({ result }),
      };
    }

    if (toolName === 'browser_close') {
      const closed = await getBrowserPool().close(context?.sessionId);
      return {
        content: [
          {
            type: 'text',
            text: closed
              ? 'Browser session closed.'
              : 'No active browser session was found.',
          },
        ],
        structuredContent: toJsonValue({ closed }),
      };
    }

    return buildError(`Unknown builtin browser tool: ${toolName}`);
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Browser tool execution failed',
    );
  }
}
